/**
 * ThemeCommand — Registers the `jolli theme` command group.
 *
 * Subcommands:
 *   list      — List available themes from the Jolli theme registry
 *   preview   — Download a theme and preview it with demo content
 *   install   — Download a theme to ~/.jolli/themes/<name>/
 */

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Command } from "commander";
import { extract } from "tar";
import { scaffoldProject } from "../site/StarterKit.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const THEMES_REPO = "jolliai/themes";
const REGISTRY_URL = `https://raw.githubusercontent.com/${THEMES_REPO}/main/registry.json`;
const USER_THEMES_DIR = join(homedir(), ".jolli", "themes");

/**
 * Returns auth headers for GitHub fetches when `GITHUB_TOKEN` (or `GH_TOKEN`)
 * is set. Required while `jolliai/themes` is a private repo; once the repo
 * is public this becomes a no-op for unauthenticated users while still
 * raising the rate limit when set.
 */
export function githubAuthHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

const AUTH_HINT =
	"If this is a private repo, set GITHUB_TOKEN (or GH_TOKEN) to a token with read access " +
	"(e.g. `export GITHUB_TOKEN=$(gh auth token)`).";

interface RegistryTheme {
	name: string;
	version: string;
	description: string;
	tags?: string[];
}

interface RegistryData {
	url?: string;
	themes: RegistryTheme[];
}

/** Metadata saved alongside installed themes for version tracking. */
interface InstalledMeta {
	version: string;
	installedAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Reads the installed version from the theme's manifest.mjs (source of truth),
 * falling back to .jolli-theme.json for legacy installs.
 */
async function readInstalledVersion(name: string): Promise<string | undefined> {
	// 1) manifest.mjs — source of truth
	const manifestPath = join(USER_THEMES_DIR, name, "manifest.mjs");
	if (existsSync(manifestPath)) {
		try {
			const mod = await import(`file://${manifestPath}`);
			const manifest = mod.default ?? mod;
			if (typeof manifest.version === "string") return manifest.version;
		} catch {
			// fall through
		}
	}
	// 2) .jolli-theme.json — legacy fallback
	const metaPath = join(USER_THEMES_DIR, name, ".jolli-theme.json");
	if (!existsSync(metaPath)) return undefined;
	try {
		const raw = await readFile(metaPath, "utf-8");
		return (JSON.parse(raw) as InstalledMeta).version;
	} catch {
		return undefined;
	}
}

async function writeInstalledMeta(name: string, version: string): Promise<void> {
	const metaPath = join(USER_THEMES_DIR, name, ".jolli-theme.json");
	const meta: InstalledMeta = { version, installedAt: new Date().toISOString() };
	await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

async function fetchRegistry(): Promise<RegistryData> {
	let res: Response;
	try {
		res = await fetch(REGISTRY_URL, { headers: githubAuthHeaders() });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Could not reach ${REGISTRY_URL}: ${detail}`);
	}
	if (!res.ok) {
		const hint = res.status === 401 || res.status === 403 || res.status === 404 ? ` ${AUTH_HINT}` : "";
		throw new Error(`Could not fetch theme registry from ${REGISTRY_URL}: ${res.status} ${res.statusText}.${hint}`);
	}
	return (await res.json()) as RegistryData;
}

/**
 * Downloads a theme to `~/.jolli/themes/<name>/` from the canonical GitHub
 * repo (`github.com/jolliai/themes`). Saves version metadata from the
 * registry when available. Throws on network error or when the theme is
 * not present in the repo — callers decide whether to fall back to the
 * already-cached copy under `~/.jolli/themes/<name>/`.
 *
 * Uses the public `codeload.github.com` tarball endpoint (one request for
 * the whole repo, no `api.github.com` rate-limit consumption) and extracts
 * only the requested `<name>/` directory into the destination.
 */
export async function downloadTheme(name: string, version?: string): Promise<string> {
	const destDir = join(USER_THEMES_DIR, name);
	const tarballUrl = `https://codeload.github.com/${THEMES_REPO}/tar.gz/refs/heads/main`;

	let res: Response;
	try {
		res = await fetch(tarballUrl, { headers: githubAuthHeaders() });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Could not reach ${tarballUrl}: ${detail}`);
	}
	if (!res.ok || !res.body) {
		const hint = res.status === 401 || res.status === 403 || res.status === 404 ? ` ${AUTH_HINT}` : "";
		throw new Error(`Could not fetch theme repo from ${tarballUrl}: ${res.status} ${res.statusText}.${hint}`);
	}

	const tmpRoot = await mkdtemp(join(tmpdir(), "jolli-themes-"));
	try {
		// `tar.extract` auto-detects the gzip layer; pipe the response into it.
		// fetch returns a web ReadableStream; Readable.fromWeb bridges to a node stream.
		const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
		await pipeline(nodeStream, extract({ cwd: tmpRoot }));

		// codeload tarballs unpack into a single root directory like
		// `themes-main/` (repo-ref). Look up that root and resolve the theme.
		const rootEntries = await readdir(tmpRoot);
		if (rootEntries.length !== 1) {
			throw new Error(`Unexpected tarball layout: ${rootEntries.length} entries at root`);
		}
		const srcDir = join(tmpRoot, rootEntries[0], name);
		if (!existsSync(srcDir)) {
			throw new Error(`Theme "${name}" not found in ${THEMES_REPO}`);
		}

		// Replace the destination with the extracted copy so a partial older
		// install can't leave stale files lying around.
		await rm(destDir, { recursive: true, force: true });
		await mkdir(destDir, { recursive: true });
		await cp(srcDir, destDir, { recursive: true });

		if (version) await writeInstalledMeta(name, version);
		return destDir;
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

async function listThemes(): Promise<void> {
	try {
		const registry = await fetchRegistry();
		const repoUrl = registry.url ?? `https://github.com/${THEMES_REPO}`;
		console.log(`\n  Available themes from ${repoUrl}\n`);
		for (const theme of registry.themes) {
			const installed = existsSync(join(USER_THEMES_DIR, theme.name));
			const installedVersion = installed ? await readInstalledVersion(theme.name) : undefined;
			let badge = "";
			if (installed && installedVersion && theme.version && installedVersion !== theme.version) {
				badge = ` (v${installedVersion} → v${theme.version} update available)`;
			} else if (installed && installedVersion) {
				badge = ` (v${installedVersion} installed)`;
			} else if (installed) {
				badge = " (installed)";
			} else {
				badge = ` v${theme.version}`;
			}
			console.log(`  ${theme.name}${badge}`);
			console.log(`    ${theme.description}`);
			if (theme.tags?.length) {
				console.log(`    Tags: ${theme.tags.join(", ")}`);
			}
			console.log();
		}
		console.log(`  Built-in: default, forge, atlas\n`);
	} catch (err) {
		console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

async function installTheme(name: string): Promise<void> {
	// Look up version from registry
	let version: string | undefined;
	try {
		const registry = await fetchRegistry();
		version = registry.themes.find((t) => t.name === name)?.version;
	} catch {
		// proceed without version
	}

	const destDir = join(USER_THEMES_DIR, name);
	if (existsSync(destDir)) {
		const installedVersion = await readInstalledVersion(name);
		if (installedVersion && version && installedVersion === version) {
			console.log(`\n  Theme "${name}" v${version} is already installed and up to date.\n`);
			return;
		}
		if (installedVersion && version && installedVersion !== version) {
			console.log(`\n  Updating theme "${name}" from v${installedVersion} to v${version}...`);
			await rm(destDir, { recursive: true, force: true });
		} else {
			console.log(`\n  Reinstalling theme "${name}"...`);
			await rm(destDir, { recursive: true, force: true });
		}
	}

	console.log(`\n  Downloading theme "${name}" from ${THEMES_REPO}...`);
	try {
		const dir = await downloadTheme(name, version);
		console.log(`  ✓ Installed${version ? ` v${version}` : ""} to ${dir}\n`);
		console.log(`  To use: set "theme": { "pack": "${name}" } in site.json\n`);
	} catch (err) {
		console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

async function previewTheme(name: string): Promise<void> {
	// 1. Install if not present
	const themeDir = join(USER_THEMES_DIR, name);
	if (!existsSync(themeDir)) {
		console.log(`\n  Downloading theme "${name}"...`);
		try {
			await downloadTheme(name);
			console.log(`  ✓ Downloaded to ${themeDir}`);
		} catch (err) {
			console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
			process.exitCode = 1;
			return;
		}
	}

	// 2. Scaffold demo content to a temp dir
	const tmpDir = join(homedir(), ".jolli", "theme-preview", name);
	if (existsSync(tmpDir)) {
		await rm(tmpDir, { recursive: true, force: true });
	}
	const result = await scaffoldProject(tmpDir);
	if (!result.success) {
		console.error(`  Error: ${result.message}`);
		process.exitCode = 1;
		return;
	}

	// 3. Launch dev server with the theme
	console.log(`  Starting preview with theme "${name}"...\n`);

	// Dynamic import to avoid circular dependency with StartCommand
	const { runDevServer } = await import("./StartCommand.js");
	await runDevServer(tmpDir, { theme: themeDir, verbose: false });
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerThemeCommand(program: Command): void {
	const theme = program.command("theme").description("Manage documentation themes");

	theme.command("list").description("List available themes from the Jolli theme registry").action(listThemes);

	theme.command("install <name>").description("Download a theme to ~/.jolli/themes/").action(installTheme);

	theme.command("preview <name>").description("Preview a theme with demo content").action(previewTheme);
}
