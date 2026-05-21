/**
 * ThemeCommand — Registers the `jolli theme` command group.
 *
 * Subcommands:
 *   list      — List available themes from the Jolli theme registry
 *   preview   — Download a theme and preview it with demo content
 *   install   — Download a theme to ~/.jolli/themes/<name>/
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { scaffoldProject } from "../site/StarterKit.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const THEMES_REPO = "jolliai/themes";
const REGISTRY_URL = `https://raw.githubusercontent.com/${THEMES_REPO}/main/registry.json`;
const USER_THEMES_DIR = join(homedir(), ".jolli", "themes");

/**
 * Fallback local registry path — used during development before the
 * GitHub repo is created, or when offline. Set via JOLLI_THEMES_DIR env.
 */
const LOCAL_THEMES_DIR = process.env.JOLLI_THEMES_DIR ?? join(homedir(), "jolli.ai", "themes");

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
	// Try GitHub first
	try {
		const res = await fetch(REGISTRY_URL);
		if (res.ok) {
			return (await res.json()) as RegistryData;
		}
	} catch {
		// Network error — fall through to local
	}

	// Fallback: local registry.json (development / offline)
	const localRegistry = join(LOCAL_THEMES_DIR, "registry.json");
	if (existsSync(localRegistry)) {
		const { readFile } = await import("node:fs/promises");
		const raw = await readFile(localRegistry, "utf-8");
		return JSON.parse(raw) as RegistryData;
	}

	throw new Error("Could not fetch theme registry from GitHub or local fallback");
}

/**
 * Downloads a theme to `~/.jolli/themes/<name>/`.
 * GitHub is the source of truth; local themes directory is the offline fallback.
 * Saves version metadata from registry when available.
 */
export async function downloadTheme(name: string, version?: string): Promise<string> {
	const destDir = join(USER_THEMES_DIR, name);

	// 1) GitHub Contents API (source of truth)
	try {
		const contentsUrl = `https://api.github.com/repos/${THEMES_REPO}/contents/${name}`;
		const res = await fetch(contentsUrl, {
			headers: { Accept: "application/vnd.github.v3+json" },
		});
		if (res.ok) {
			const files = (await res.json()) as Array<{
				name: string;
				download_url: string | null;
				type: string;
			}>;
			await mkdir(destDir, { recursive: true });
			for (const file of files) {
				if (file.type !== "file" || !file.download_url) continue;
				const fileRes = await fetch(file.download_url);
				if (!fileRes.ok) {
					throw new Error(`Failed to download ${file.name}: ${fileRes.status}`);
				}
				const content = await fileRes.text();
				await writeFile(join(destDir, file.name), content, "utf-8");
			}
			if (version) await writeInstalledMeta(name, version);
			return destDir;
		}
		if (res.status !== 404) {
			throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
		}
	} catch (err) {
		// Network error — fall through to local fallback
		if (err instanceof Error && err.message.startsWith("GitHub API")) throw err;
	}

	// 2) Local themes directory (offline fallback)
	const localThemeDir = join(LOCAL_THEMES_DIR, name);
	if (existsSync(localThemeDir)) {
		await mkdir(destDir, { recursive: true });
		const { readdir, copyFile } = await import("node:fs/promises");
		const files = await readdir(localThemeDir);
		for (const file of files) {
			await copyFile(join(localThemeDir, file), join(destDir, file));
		}
		if (version) await writeInstalledMeta(name, version);
		return destDir;
	}

	throw new Error(`Theme "${name}" not found in ${THEMES_REPO} or local themes directory`);
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
