/**
 * UninstallScan — machine-wide discovery of every Jolli Memory installation and
 * configuration artifact, for the `jolli uninstall` command.
 *
 * Scope (vs `disable`): `disable` strips the CURRENT repo's hook sections and
 * repo-scoped MCP entries. `uninstall` is machine-wide: it also finds the VS
 * Code / IntelliJ editor artifacts, the globally-installed CLI package, and the
 * global + per-project `.jolli/jollimemory/` state directories.
 *
 * HARD EXCLUSION — user memory is never in the inventory:
 *   - the `jollimemory/summaries/v3` git orphan branch (system of record), and
 *   - the Memory Bank folder (default `~/Documents/jolli/`, or the configured
 *     `localFolder`) which holds summary/transcript/plan/note content.
 * Only *installation and configuration* is removable. The global config dir
 * (`~/.jolli/jollimemory/`) is config/state only — API keys, dist-paths, hook
 * entry scripts — and lives on a different path than the Memory Bank, so
 * removing it never touches memory content.
 *
 * Every path input is injectable (`home`, `platform`, `projectDir`,
 * `npmGlobalRoots`) so the scan is deterministic and fully unit-testable
 * without touching the real machine.
 */

import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { getGlobalConfigDir } from "../core/SessionTracker.js";
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import { execFileAsyncHidden } from "../util/Subprocess.js";
import { getStatus } from "./Installer.js";

const log = createLogger("UninstallScan");

/** The distinct surfaces a Jolli install can occupy. */
export type UninstallSurface =
	| "vscode-extension"
	| "intellij-plugin"
	| "cli-global"
	| "global-config"
	| "project-config"
	| "repo-hooks";

/** How the command removes an item. */
export type RemovableKind = "file" | "dir" | "hooks";

/** A single removable artifact discovered on disk (or a pseudo-item for hooks). */
export interface RemovableItem {
	readonly surface: UninstallSurface;
	/** Human-readable one-line label shown in the inventory. */
	readonly label: string;
	/** Absolute path. For `hooks`, the repo dir the hook-strip operates on. */
	readonly path: string;
	readonly kind: RemovableKind;
	/** Optional extra context (version, editor name). */
	readonly detail?: string;
}

/** Result of a full scan: removable items plus notes on what is preserved. */
export interface UninstallInventory {
	readonly items: readonly RemovableItem[];
	/** Human-readable notes about data the command deliberately never removes. */
	readonly preserved: readonly string[];
}

/** Options for {@link scanUninstallInventory} and the per-surface scanners. */
export interface ScanOptions {
	/** Home directory (defaults to `os.homedir()`). */
	readonly home?: string;
	/** Platform override (defaults to `os.platform()`). */
	readonly platform?: NodeJS.Platform;
	/** Project directory used for the project-config + repo-hooks surfaces. */
	readonly projectDir?: string;
	/**
	 * Global `node_modules` roots to probe for `@jolli.ai/cli`. When omitted,
	 * {@link resolveNpmGlobalRoots} is invoked (spawns `npm root -g`). Passed
	 * explicitly by tests to avoid spawning.
	 */
	readonly npmGlobalRoots?: readonly string[];
}

// ─── VS Code family ──────────────────────────────────────────────────────────

/**
 * VS Code-family extension roots, all under `$HOME` on every platform (VS Code
 * stores extensions in `~/.vscode/extensions` regardless of OS). Keyed by the
 * home-relative directory holding the `extensions/` folder; value is the label
 * shown to the user.
 *
 * Covers the VS Code forks Jolli installs into: Cursor, Windsurf, Antigravity
 * (ships two data dirs — `.antigravity` and the current `.antigravity-ide`),
 * VSCodium, Positron, Kiro, Devin's desktop editor, and the stock VS Code /
 * Insiders / remote-server dirs. The data-folder names were verified against
 * real installs — a fork's dir name is not always its brand name (Antigravity →
 * `.antigravity-ide`), so entries here are observed, not guessed. Absent editors
 * are skipped by readdir.
 */
const VSCODE_EXTENSION_ROOTS: ReadonlyArray<readonly [string, string]> = [
	[".vscode", "VS Code"],
	[".vscode-insiders", "VS Code Insiders"],
	[".vscode-oss", "VSCodium"],
	[".vscode-server", "VS Code Server (remote)"],
	[".cursor", "Cursor"],
	[".windsurf", "Windsurf"],
	[".antigravity", "Antigravity"],
	[".antigravity-ide", "Antigravity"],
	[".kiro", "Kiro"],
	[".positron", "Positron"],
	[".devin", "Devin"],
];

/** Extension folder prefix: `<publisher>.<name>` = `jolli.jollimemory-vscode`. */
const VSCODE_EXTENSION_PREFIX = "jolli.jollimemory-vscode";

/**
 * Finds the installed Jolli Memory extension folder(s) across all detected VS
 * Code-family editors. Extension dirs are named `<publisher>.<name>-<version>`.
 */
export async function scanVscodeExtensions(home: string): Promise<RemovableItem[]> {
	const items: RemovableItem[] = [];
	for (const [rootName, editorLabel] of VSCODE_EXTENSION_ROOTS) {
		const extDir = join(home, rootName, "extensions");
		let entries: string[];
		try {
			entries = await readdir(extDir);
		} catch {
			// Editor not installed / no extensions dir — skip silently.
			continue;
		}
		for (const entry of entries) {
			if (!entry.startsWith(VSCODE_EXTENSION_PREFIX)) continue;
			const version = entry.slice(VSCODE_EXTENSION_PREFIX.length + 1) || undefined;
			items.push({
				surface: "vscode-extension",
				label: `Jolli Memory extension — ${editorLabel}`,
				path: join(extDir, entry),
				kind: "dir",
				detail: version ? `v${version}` : undefined,
			});
		}
	}
	return items;
}

/**
 * Reconciles a VS Code-family editor's `extensions/extensions.json` manifest
 * after the extension folder has been deleted.
 *
 * VS Code (and every fork) treats `<extensionsDir>/extensions.json` as the
 * source of truth for what is installed. Deleting only the extension folder
 * leaves a dangling manifest entry, so on next launch the editor lists the
 * extension in its UI with a "cannot find / corrupt" warning (and may try to
 * reinstall it). Removing the manifest entry whose `relativeLocation` matches
 * the deleted folder makes the editor see a clean uninstall.
 *
 * Best-effort and never throws: a missing manifest (older editors), malformed
 * JSON, or a write failure is logged and swallowed — the folder deletion is the
 * primary action and its success is reported independently by the caller.
 *
 * @param extensionDir Absolute path to the deleted extension folder
 *   (`<extensionsDir>/<publisher>.<name>-<version>`).
 */
export async function pruneVscodeExtensionManifest(extensionDir: string): Promise<void> {
	const manifestPath = join(dirname(extensionDir), "extensions.json");
	const folderName = basename(extensionDir);

	let raw: string;
	try {
		raw = await readFile(manifestPath, "utf8");
	} catch {
		// No manifest (older VS Code, or fork without one) — nothing to reconcile.
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		log.warn("extensions.json at %s is not valid JSON — skipping prune: %s", manifestPath, (err as Error).message);
		return;
	}
	if (!Array.isArray(parsed)) return;

	const filtered = parsed.filter(
		(entry) => (entry as { relativeLocation?: unknown })?.relativeLocation !== folderName,
	);
	// Nothing matched — leave the file byte-for-byte untouched.
	if (filtered.length === parsed.length) return;

	try {
		await writeFile(manifestPath, JSON.stringify(filtered), "utf8");
	} catch (err) {
		/* v8 ignore next -- defensive: manifest write failure (EPERM/read-only) is rare */
		log.warn("Failed to update extensions.json at %s: %s", manifestPath, (err as Error).message);
	}
}

// ─── IntelliJ / JetBrains family ──────────────────────────────────────────────

/** Per-platform config root for a JetBrains-platform vendor (`JetBrains`, `Google`). */
export function getVendorConfigRoot(vendor: string, home: string, platform: NodeJS.Platform): string {
	switch (platform) {
		case "darwin":
			return join(home, "Library", "Application Support", vendor);
		case "win32":
			return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), vendor);
		default:
			return join(home, ".local", "share", vendor);
	}
}

/** Per-platform JetBrains config root holding `<Product><Version>/` dirs. */
export function getJetBrainsRoot(home: string, platform: NodeJS.Platform): string {
	return getVendorConfigRoot("JetBrains", home, platform);
}

/**
 * Android Studio config root. Android Studio is IntelliJ-platform-based but
 * stores its per-version config under `Google/AndroidStudio<Version>/` rather
 * than `JetBrains/`, so it needs a separate root.
 */
export function getAndroidStudioRoot(home: string, platform: NodeJS.Platform): string {
	return getVendorConfigRoot("Google", home, platform);
}

/**
 * Scans one vendor config root for Jolli plugin folders. The plugin folder
 * (`jollimemory-intellij`) lives under `<root>/<Product><Version>/plugins/`.
 * Matches any entry containing "jolli" (case-insensitive) to tolerate future
 * artifact renames. Returns [] if the root is absent.
 *
 * `productPrefix` narrows which product dirs are considered — the `Google/`
 * vendor root holds unrelated apps (Chrome, …), so Android Studio passes
 * `"AndroidStudio"` to avoid probing them; the JetBrains root passes nothing
 * (every product dir is a JetBrains IDE).
 */
async function scanPluginRoot(root: string, productPrefix?: string): Promise<RemovableItem[]> {
	let products: string[];
	try {
		products = await readdir(root);
	} catch {
		return [];
	}

	const items: RemovableItem[] = [];
	for (const product of products) {
		if (productPrefix && !product.startsWith(productPrefix)) continue;
		const pluginsDir = join(root, product, "plugins");
		let plugins: string[];
		try {
			plugins = await readdir(pluginsDir);
		} catch {
			// `<product>` has no plugins dir (e.g. a stray file / non-IDE dir) — skip.
			continue;
		}
		for (const plugin of plugins) {
			if (!plugin.toLowerCase().includes("jolli")) continue;
			items.push({
				surface: "intellij-plugin",
				label: `Jolli Memory plugin — ${product}`,
				path: join(pluginsDir, plugin),
				kind: "dir",
			});
		}
	}
	return items;
}

/**
 * Finds the installed Jolli Memory plugin across all IntelliJ-platform IDEs —
 * every JetBrains product (IDEA, WebStorm, PyCharm, GoLand, Rider, …) plus
 * Android Studio (under `Google/`). Absent vendor roots are skipped.
 */
export async function scanIntellijPlugins(home: string, platform: NodeJS.Platform): Promise<RemovableItem[]> {
	const [jetbrains, androidStudio] = await Promise.all([
		scanPluginRoot(getJetBrainsRoot(home, platform)),
		scanPluginRoot(getAndroidStudioRoot(home, platform), "AndroidStudio"),
	]);
	return [...jetbrains, ...androidStudio];
}

// ─── Global CLI (@jolli.ai/cli) ───────────────────────────────────────────────

/** The npm-scoped package name of the CLI. */
const CLI_PACKAGE = "@jolli.ai/cli";

/** Hard cap on the `npm root -g` probe so a hung npm can't wedge the scan. */
const NPM_ROOT_TIMEOUT_MS = 5000;

/**
 * Resolves the global `node_modules` root via `npm root -g`. Returns an empty
 * array on any failure (npm missing, non-zero exit, empty output, or the 5s
 * timeout) — the caller merges this with static candidate roots, so a failed
 * probe just narrows the search rather than breaking the scan. The timeout
 * matters because this is awaited even for `--dry-run`, so a misconfigured or
 * hung npm would otherwise hang the whole command indefinitely.
 */
export async function resolveNpmGlobalRoots(): Promise<string[]> {
	try {
		const { stdout } = await execFileAsyncHidden("npm", ["root", "-g"], { timeout: NPM_ROOT_TIMEOUT_MS });
		const root = stdout.trim();
		return root ? [root] : [];
	} catch (err) {
		log.info("npm root -g failed (non-fatal): %s", (err as Error).message);
		return [];
	}
}

/**
 * Static, no-spawn candidate global `node_modules` roots derived from home +
 * platform. Merged with the `npm root -g` result so custom prefixes and the
 * common package-manager defaults are both covered.
 */
export function staticNpmGlobalRoots(home: string, platform: NodeJS.Platform): string[] {
	if (platform === "win32") {
		const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
		return [join(appData, "npm", "node_modules")];
	}
	const roots = [
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
		join(home, ".npm-global", "lib", "node_modules"),
		join(home, ".node_modules", "lib", "node_modules"),
	];
	if (platform === "darwin") {
		roots.push("/opt/homebrew/lib/node_modules");
	}
	return roots;
}

/**
 * Derives the executable-shim candidates for a global install rooted at
 * `nodeModulesRoot`. npm lays the package under `<prefix>/lib/node_modules` (or
 * `<prefix>/node_modules`) and the `jolli` shim under `<prefix>/bin` (POSIX) or
 * directly under `<prefix>` (Windows: `jolli`, `jolli.cmd`, `jolli.ps1`).
 */
function binCandidates(nodeModulesRoot: string, platform: NodeJS.Platform): string[] {
	// Strip trailing node_modules (and an optional lib segment) to get <prefix>.
	// Reconstruct with the host separator so the derived paths match real files
	// on whichever OS we're running; `platform` only chooses the shim filenames.
	const parts = nodeModulesRoot.split(/[\\/]/);
	if (parts[parts.length - 1] === "node_modules") parts.pop();
	if (parts[parts.length - 1] === "lib") parts.pop();
	const prefix = parts.join(sep);
	if (platform === "win32") {
		return [join(prefix, "jolli"), join(prefix, "jolli.cmd"), join(prefix, "jolli.ps1")];
	}
	return [join(prefix, "bin", "jolli")];
}

/**
 * Finds the globally-installed `@jolli.ai/cli` package directory and its `jolli`
 * executable shim. Probes every candidate root; de-duplicates by path so a root
 * reported by both `npm root -g` and the static list yields one item.
 */
export async function scanCliGlobal(
	home: string,
	platform: NodeJS.Platform,
	npmGlobalRoots: readonly string[],
): Promise<RemovableItem[]> {
	const roots = [...new Set([...npmGlobalRoots, ...staticNpmGlobalRoots(home, platform)])];
	const items: RemovableItem[] = [];
	const seen = new Set<string>();

	for (const root of roots) {
		const pkgDir = join(root, CLI_PACKAGE);
		let isPkg = false;
		try {
			isPkg = (await stat(pkgDir)).isDirectory();
		} catch {
			// Not installed at this root.
		}
		if (!isPkg || seen.has(pkgDir)) continue;
		seen.add(pkgDir);
		items.push({
			surface: "cli-global",
			label: `Global CLI package (${CLI_PACKAGE})`,
			path: pkgDir,
			kind: "dir",
		});

		// The executable shim(s) live next to the prefix, not under the package.
		for (const bin of binCandidates(root, platform)) {
			if (seen.has(bin)) continue;
			try {
				// lstat: the shim is usually a symlink into the package on POSIX;
				// we want to remove the link itself, not its target.
				await lstat(bin);
			} catch {
				continue;
			}
			seen.add(bin);
			items.push({
				surface: "cli-global",
				label: "Global `jolli` executable",
				path: bin,
				kind: "file",
			});
		}
	}
	return items;
}

// ─── Config / state directories ───────────────────────────────────────────────

/** The machine-global `~/.jolli/jollimemory/` config+state directory, if present. */
export async function scanGlobalConfig(): Promise<RemovableItem[]> {
	const dir = getGlobalConfigDir();
	try {
		if (!(await stat(dir)).isDirectory()) return [];
	} catch {
		return [];
	}
	return [
		{
			surface: "global-config",
			label: "Global config & state (API keys, dist-paths, hook scripts)",
			path: dir,
			kind: "dir",
		},
	];
}

/** The per-project `<projectDir>/.jolli/jollimemory/` state directory, if present. */
export async function scanProjectConfig(projectDir: string): Promise<RemovableItem[]> {
	const dir = getJolliMemoryDir(projectDir);
	try {
		if (!(await stat(dir)).isDirectory()) return [];
	} catch {
		return [];
	}
	return [
		{
			surface: "project-config",
			label: "Project state (sessions, cursors, queue, notes, plans)",
			path: dir,
			kind: "dir",
		},
	];
}

/**
 * Detects whether the current repo has any Jolli hooks or repo-scoped MCP
 * registration installed. If so, emits a single `repo-hooks` pseudo-item whose
 * removal is dispatched to `Installer.uninstall(projectDir)` (marker-aware hook
 * stripping — never a blind file delete). Never throws: `getStatus` resolves
 * gracefully outside a git repo, in which case no item is emitted.
 */
export async function scanRepoHooks(projectDir: string): Promise<RemovableItem[]> {
	let hasHooks = false;
	try {
		const status = await getStatus(projectDir);
		hasHooks = status.gitHookInstalled || status.claudeHookInstalled || status.geminiHookInstalled;
	} catch (err) {
		log.info("getStatus failed during repo-hooks scan (non-fatal): %s", (err as Error).message);
		return [];
	}
	if (!hasHooks) return [];
	return [
		{
			surface: "repo-hooks",
			label: "Git & AI-agent hooks + repo MCP registration (current repo)",
			path: projectDir,
			kind: "hooks",
		},
	];
}

// ─── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Runs every surface scan and assembles the full inventory. Each surface is
 * isolated — a failure in one never aborts the others (individual scanners
 * already swallow their own fs errors, so this is belt-and-suspenders).
 */
export async function scanUninstallInventory(options: ScanOptions = {}): Promise<UninstallInventory> {
	const home = options.home ?? homedir();
	const platform = options.platform ?? osPlatform();
	const projectDir = options.projectDir ?? process.cwd();
	const npmGlobalRoots = options.npmGlobalRoots ?? (await resolveNpmGlobalRoots());

	const [vscode, intellij, cli, globalConfig, projectConfig, repoHooks] = await Promise.all([
		scanVscodeExtensions(home),
		scanIntellijPlugins(home, platform),
		scanCliGlobal(home, platform, npmGlobalRoots),
		scanGlobalConfig(),
		scanProjectConfig(projectDir),
		scanRepoHooks(projectDir),
	]);

	const items = [...vscode, ...intellij, ...cli, ...globalConfig, ...projectConfig, ...repoHooks];

	const preserved = [
		"Git orphan branch 'jollimemory/summaries/v3' (your commit memories)",
		"Memory Bank folder content (default ~/Documents/jolli/, or your configured localFolder)",
	];

	return { items, preserved };
}
