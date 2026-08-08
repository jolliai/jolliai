/**
 * Browse — the Repositories folder picker's server side.
 *
 * A real browser page has no OS folder-picker API that returns an absolute
 * filesystem path (`showDirectoryPicker()` is Chromium-only and hands back an
 * opaque handle, not a path `registerRepo` can use), so the mockup's OS-dialog
 * depiction is not reproducible here. This is the honest substitute: a
 * directory listing endpoint plus a typed-path field in the UI.
 *
 * Deliberately narrow: directory NAMES and whether each is a git repo, never
 * file names or file contents. Both routes that use this module are gated
 * behind the dashboard's mutation token (see `DashboardServer.ts`) — a
 * walkable home tree is a broader disclosure than anything the read-only
 * routes already leak (repo paths, commit subjects), so it inherits the
 * write surface's gate rather than staying open like the GET routes.
 */

import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directories a browse can never descend into, even if named explicitly. */
const FORBIDDEN_ROOTS = new Set(["/proc", "/sys"]);

/** Most entries one listing returns — a page budget, not a scan limit. */
export const BROWSE_ENTRY_LIMIT = 500;

export interface BrowseEntry {
	readonly name: string;
	readonly isGitRepo: boolean;
}

export interface BrowseResult {
	readonly path: string;
	readonly parent: string | null;
	readonly entries: ReadonlyArray<BrowseEntry>;
	readonly truncated: boolean;
}

export class BrowseError extends Error {}

/**
 * Lists the directories inside `requestedPath`. Throws {@link BrowseError}
 * with a message safe to return to the client (no raw filesystem errors,
 * which can leak unrelated path structure).
 */
export async function browseDirectory(requestedPath: string): Promise<BrowseResult> {
	if (!requestedPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(requestedPath)) {
		throw new BrowseError("path must be absolute");
	}
	let resolved: string;
	try {
		resolved = await realpath(requestedPath);
	} catch {
		throw new BrowseError("path does not exist");
	}
	for (const forbidden of FORBIDDEN_ROOTS) {
		if (resolved === forbidden || resolved.startsWith(`${forbidden}/`)) {
			throw new BrowseError("path is not browsable");
		}
	}

	let names: ReadonlyArray<string>;
	try {
		const dirents = await readdir(resolved, { withFileTypes: true });
		names = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		throw new BrowseError("path is not a directory");
	}

	// Code-point order, not locale order: the picker's paging cut (BROWSE_ENTRY_LIMIT)
	// must not depend on the machine's LANG.
	const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const truncated = sorted.length > BROWSE_ENTRY_LIMIT;
	const page = truncated ? sorted.slice(0, BROWSE_ENTRY_LIMIT) : sorted;
	const entries: BrowseEntry[] = page.map((name) => ({
		name,
		isGitRepo: existsSync(join(resolved, name, ".git")),
	}));

	const parent = join(resolved, "..");
	return {
		path: resolved,
		parent: parent === resolved ? null : parent,
		entries,
		truncated,
	};
}

/** Where the picker opens with no prior state — `~/code` if it exists, else home. */
export function defaultBrowsePath(): string {
	const preferred = join(homedir(), "code");
	return existsSync(preferred) ? preferred : homedir();
}
