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
import { join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Command } from "commander";
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

// ─── Minimal tar.gz extractor (zero dependencies) ──────────────────────────
//
// tar format: each entry = 512-byte header + ceil(size/512)*512 bytes of data.
// Header fields are NUL-terminated octal ASCII strings at fixed offsets.
// We only need: name (0, 100), size (124, 12), typeflag (156, 1), prefix (345, 155).
//
// Limitations (intentional for a theme installer):
//   - UStar prefix(155) + name(100) covers paths up to 255 bytes.
//   - PAX extended ('x') and GNU LongName ('L','K') headers are rejected;
//     entries with paths > 255 bytes will cause an error.
//   - PAX global header ('g') is skipped — it carries archive-wide metadata
//     (e.g. the git commit hash GitHub prepends to every tarball) and has no
//     effect on later entries, so ignoring it is safe.
//   - Hardlinks ('1') and symlinks ('2') are rejected for safety.

interface TarEntry {
	path: string;
	type: "file" | "dir";
	data: Buffer;
}

/** Parse a NUL-terminated octal string from a tar header field. */
function parseOctal(buf: Buffer, offset: number, length: number): number {
	const slice = buf.subarray(offset, offset + length);
	const str = slice.toString("ascii").replace(/\0.*$/, "").trim();
	return str.length === 0 ? 0 : Number.parseInt(str, 8);
}

/** Read a NUL-terminated ASCII string from a tar header field. */
function parseString(buf: Buffer, offset: number, length: number): string {
	const slice = buf.subarray(offset, offset + length);
	const idx = slice.indexOf(0);
	return (idx >= 0 ? slice.subarray(0, idx) : slice).toString("ascii");
}

/**
 * Extracts all entries from a .tar.gz buffer using only `node:zlib`.
 * Decompresses once and returns all file/directory entries.
 */
export function extractTarGz(gzBuf: Buffer): TarEntry[] {
	const tar = gunzipSync(gzBuf);

	const entries: TarEntry[] = [];
	let offset = 0;

	while (offset + 1024 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		// Two consecutive 512-byte zero blocks = end of archive (POSIX)
		const nextBlock = tar.subarray(offset + 512, offset + 1024);
		if (header.every((b) => b === 0) && nextBlock.every((b) => b === 0)) break;
		// Single zero block mid-archive: skip it
		if (header.every((b) => b === 0)) {
			offset += 512;
			continue;
		}

		const prefix = parseString(header, 345, 155);
		const rawName = parseString(header, 0, 100);
		const fullPath = prefix ? `${prefix}/${rawName}` : rawName;
		const size = parseOctal(header, 124, 12);
		const typeflag = header[156];

		offset += 512; // move past header

		const isFile = typeflag === 0 || typeflag === 0x30; // 0x30 = '0'
		const isDir = typeflag === 0x35; // '5'

		// Reject unsupported entry types that would corrupt the extraction:
		//   'L','K','x' — long-name/extended headers that rename the NEXT entry
		//   '1','2'     — hard/soft links that could escape the destination dir
		// 'g' (PAX global header) is intentionally excluded — it carries
		// archive-wide metadata (e.g. the git commit hash that GitHub prepends
		// to every codeload tarball) and has no effect on later entries, so the
		// safe behavior is to skip it like any other benign extension.
		if (!isFile && !isDir) {
			const flag = String.fromCharCode(typeflag);
			if ("LKx12".includes(flag)) {
				throw new Error(
					`Unsupported tar entry type '${flag}' for "${fullPath}". ` +
						"This tar parser only supports regular files and directories.",
				);
			}
			// Skip other benign typeflags (PAX global header 'g', vendor extensions, …)
			offset += Math.ceil(size / 512) * 512;
			continue;
		}

		if (fullPath.length > 0) {
			const data = isFile ? Buffer.from(tar.subarray(offset, offset + size)) : Buffer.alloc(0);
			entries.push({ path: fullPath, type: isFile ? "file" : "dir", data });
		}

		// Advance past data blocks (rounded up to 512-byte boundary)
		offset += Math.ceil(size / 512) * 512;
	}

	return entries;
}

/**
 * Downloads a theme to `~/.jolli/themes/<name>/` from the canonical GitHub
 * repo (`github.com/jolliai/themes`). Saves version metadata from the
 * registry when available. Throws on network error or when the theme is
 * not present in the repo — callers decide whether to fall back to the
 * already-cached copy under `~/.jolli/themes/<name>/`.
 *
 * Uses the public `codeload.github.com` tarball endpoint (single request,
 * no API rate-limit) and a built-in tar.gz parser — zero external
 * dependencies, works on all platforms.
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
	if (!res.ok) {
		const hint = res.status === 401 || res.status === 403 || res.status === 404 ? ` ${AUTH_HINT}` : "";
		throw new Error(`Could not fetch theme repo from ${tarballUrl}: ${res.status} ${res.statusText}.${hint}`);
	}

	const gzBuf = Buffer.from(await res.arrayBuffer());

	// Single-pass: decompress once, detect root dir, filter for `<root>/<name>/`.
	const allEntries = extractTarGz(gzBuf);
	if (allEntries.length === 0) throw new Error("Empty tarball");
	const rootDir = allEntries[0].path.split("/")[0];
	const prefix = `${rootDir}/${name}/`;

	const themeEntries = allEntries.flatMap((e) => {
		if (!e.path.startsWith(prefix)) return [];
		const relPath = e.path.slice(prefix.length);
		return relPath.length === 0 ? [] : [{ ...e, path: relPath }];
	});
	if (themeEntries.length === 0) {
		throw new Error(`Theme "${name}" not found in ${THEMES_REPO}`);
	}

	// Replace the destination so stale files don't linger.
	await rm(destDir, { recursive: true, force: true });

	// Ensure destDir uses a trailing separator for the path-traversal check
	// so that a sibling directory sharing the same prefix (e.g. "foobar" vs "foo")
	// is correctly rejected.
	const destDirWithSep = destDir.endsWith(sep) ? destDir : destDir + sep;
	for (const entry of themeEntries) {
		const dest = normalize(join(destDir, entry.path));
		if (dest !== destDir && !dest.startsWith(destDirWithSep)) continue;

		if (entry.type === "dir") {
			await mkdir(dest, { recursive: true });
		} else {
			await mkdir(normalize(join(dest, "..")), { recursive: true });
			await writeFile(dest, entry.data);
		}
	}

	if (version) await writeInstalledMeta(name, version);
	return destDir;
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
