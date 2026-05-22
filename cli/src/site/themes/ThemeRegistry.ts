/**
 * ThemeRegistry — pluggable theme pack API.
 *
 * Each theme pack implements `ThemePackProvider`, which encapsulates the
 * pack's manifest (identity + defaults), CSS builder, and layout generator.
 * All packs are external — no built-in packs ship with the CLI.
 * Packs can be registered at runtime via `registerPack()`.
 *
 * Theme discovery chain (searched in order by `discoverPack`):
 *   1. --theme CLI flag → absolute or relative folder path
 *   2. Registry (packs registered at runtime)
 *   3. Explicit file path in site.json (starts with `./` or `/`)
 *   4. User theme directory → ~/.jolli/themes/<name>/index.mjs
 *   5. npm package → jolli-theme-<name>
 *   6. npm scoped package → @jolli/theme-<name>
 *   7. GitHub registry → github.com/jolliai/themes/<name>/
 */

import { existsSync, statSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NextraProjectConfig } from "../NextraProjectWriter.js";
import type { DefaultThemeMode, FontFamily } from "../Types.js";

// ─── ThemePackManifest ──────────────────────────────────────────────────────

/** Identity and customer-overridable defaults for a theme pack. */
export interface ThemePackManifest {
	/** Machine name used in `theme.pack` (e.g. `"forge"`). */
	name: string;
	/** Human-readable display name (e.g. `"Forge"`). */
	displayName: string;
	/** One-line description (e.g. `"Clean developer docs"`). */
	tagline: string;
	/** Pack-specific defaults applied when the corresponding `theme.*` field is unset. */
	defaults: {
		primaryHue: number;
		defaultTheme: DefaultThemeMode;
		fontFamily: FontFamily;
		/** Pack's base accent saturation (used by `resolveAccent` fallback). */
		accentSaturation?: number;
		/** Pack's base accent lightness (used by `resolveAccent` fallback). */
		accentLightness?: number;
	};
	/**
	 * Declares which navigation features this theme supports. When a feature
	 * is `false`, the CLI warns at build time if the site.json uses it —
	 * preventing users from deploying a site with silently broken navigation.
	 *
	 * All capabilities default to `true` when omitted, so only themes with
	 * limitations need to declare them.
	 */
	supports?: {
		/** Whether the theme can render page-mode navigation (navbar page tabs). Defaults to `true`. */
		pages?: boolean;
		/** Whether the theme can render menu page dropdowns. Defaults to `true`. */
		menuPages?: boolean;
	};
}

// ─── ThemePackProvider ──────────────────────────────────────────────────────

/**
 * A theme pack implements this interface to participate in site generation.
 * The registry dispatches to the provider's methods for CSS and layout.
 */
export interface ThemePackProvider {
	/** Pack manifest — identity and defaults. */
	manifest: ThemePackManifest;

	/**
	 * Builds the complete pack CSS string. Called once during
	 * `initNextraProject` and written to `app/themes/<name>.css`.
	 * Return `undefined` to skip CSS generation (e.g. the default theme).
	 */
	buildCss(config: NextraProjectConfig): string | undefined;

	/**
	 * Generates the `app/layout.tsx` content string.
	 */
	generateLayout(config: NextraProjectConfig): string;
}

// ─── Registry ──────────────────────────────────────────────────────────────

const packs = new Map<string, ThemePackProvider>();

/** Register a theme pack provider. Overwrites any existing pack with the same name. */
export function registerPack(provider: ThemePackProvider): void {
	packs.set(provider.manifest.name, provider);
}

/** Look up a registered theme pack by name (built-in only, no discovery). */
export function getPack(name: string): ThemePackProvider | undefined {
	return packs.get(name);
}

/** List all registered pack names. */
export function listPacks(): string[] {
	return [...packs.keys()];
}

/**
 * Synchronous resolve — checks the registry only (no async discovery).
 * Used by `generateLayout` (which is sync).
 */
export function resolvePack(config: NextraProjectConfig): ThemePackProvider | undefined {
	const name = config.theme?.pack ?? "forge";
	return packs.get(name);
}

// ─── Theme discovery ──────────────────────────────────────────────────────

/** User-local theme directory. */
const USER_THEMES_DIR = join(homedir(), ".jolli", "themes");

/**
 * Discovers and loads a theme pack by name, searching in order:
 *   1. `--theme` CLI path (passed as `themePath`) — always wins
 *   2. Registry (packs registered at runtime)
 *   3. Explicit file path in site.json (starts with `./` or `/`)
 *   4. User theme directory (`~/.jolli/themes/<name>/index.mjs`)
 *   5. npm package (`jolli-theme-<name>`)
 *   6. npm scoped package (`@jolli/theme-<name>`)
 *   7. GitHub registry (`github.com/jolliai/themes/<name>/`)
 *
 * Returns the provider (now also registered) or `undefined` if not found.
 */
export async function discoverPack(
	config: NextraProjectConfig,
	options?: { themePath?: string; sourceRoot?: string },
): Promise<ThemePackProvider | undefined> {
	// 1) --theme CLI flag always wins (explicit user intent)
	if (options?.themePath) {
		return loadFromPath(options.themePath);
	}

	const name = config.theme?.pack ?? "forge";

	// 2) Registry (packs registered at runtime)
	const builtin = packs.get(name);
	if (builtin) return builtin;

	// 3) Explicit file path in site.json (starts with ./ or /)
	if (name.startsWith("./") || name.startsWith("/")) {
		const abs = name.startsWith("/") ? name : resolve(options?.sourceRoot ?? process.cwd(), name);
		return loadFromPath(abs);
	}

	// 4) User theme directory: ~/.jolli/themes/<name>/
	//    Check if a newer version is available on GitHub and update if so.
	const userThemePath = join(USER_THEMES_DIR, name);
	if (existsSync(userThemePath)) {
		await checkAndUpdateCachedTheme(name, userThemePath);
		return loadFromPath(userThemePath);
	}

	// 5) npm package: jolli-theme-<name>
	try {
		return await loadFromModule(`jolli-theme-${name}`);
	} catch {
		// not found as npm package
	}

	// 6) npm scoped package: @jolli/theme-<name>
	try {
		return await loadFromModule(`@jolli/theme-${name}`);
	} catch {
		// not found
	}

	// 7) GitHub registry: github.com/jolliai/themes/<name>/
	//
	// On any failure here (network unreachable, theme not in repo, …) the
	// cached copy under ~/.jolli/themes/<name>/ would have been picked up by
	// step 4 above. So if we got here, neither GitHub nor the cache had the
	// theme — log a clear error and let the caller (`generateLayout`) fall
	// back to the vanilla Nextra layout.
	try {
		const { downloadTheme } = await import("../../commands/ThemeCommand.js");
		console.log(`  Downloading theme "${name}" from GitHub...`);
		const destDir = await downloadTheme(name);
		console.log(`  ✓ Theme "${name}" installed to ${destDir}`);
		return loadFromPath(destDir);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error(
			`  Error: Could not load theme "${name}" — ${detail}.\n` +
				`         No cached copy at ${join(USER_THEMES_DIR, name)} either. ` +
				`Falling back to the default Nextra layout.`,
		);
	}

	return undefined;
}

// ─── Cache version check ────────────────────────────────────────────────

/**
 * How long a cached theme is considered "fresh" before we re-check the
 * registry. 24 h is enough to pick up a published theme update within a day
 * while reducing GitHub traffic from "every build" to "once per day per
 * machine per theme".
 */
const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Sentinel file whose mtime records the last successful version-check attempt. */
const LAST_CHECKED_FILE = ".last-checked";

/**
 * Returns `true` when the cached theme has never been version-checked or the
 * last check was longer ago than the TTL. Missing / unreadable sentinel
 * counts as "never checked" so a fresh install always probes once.
 */
async function isVersionCheckDue(cachedPath: string): Promise<boolean> {
	try {
		const info = await stat(join(cachedPath, LAST_CHECKED_FILE));
		return Date.now() - info.mtimeMs >= VERSION_CHECK_TTL_MS;
	} catch {
		return true;
	}
}

/**
 * Marks the cached theme as version-checked at the start of the check so a
 * transient GitHub outage during the network call doesn't cause every
 * subsequent build to retry — we wait out the TTL and try again later.
 */
async function markVersionChecked(cachedPath: string): Promise<void> {
	try {
		await writeFile(join(cachedPath, LAST_CHECKED_FILE), new Date().toISOString(), "utf-8");
	} catch {
		// Best-effort; failing to write just means the next build re-checks early.
	}
}

/**
 * Checks the cached theme's version against the GitHub registry.
 * If a newer version is available, re-downloads the theme in-place.
 * Fails silently (keeps cached version) on network errors.
 *
 * Skips the network call entirely when the previous check was within
 * `VERSION_CHECK_TTL_MS` — see `isVersionCheckDue`.
 */
async function checkAndUpdateCachedTheme(name: string, _cachedPath: string): Promise<void> {
	if (!(await isVersionCheckDue(_cachedPath))) return;
	await markVersionChecked(_cachedPath);

	try {
		const { downloadTheme, githubAuthHeaders } = await import("../../commands/ThemeCommand.js");

		// Read cached version from manifest.mjs
		const manifestPath = join(_cachedPath, "manifest.mjs");
		let cachedVersion: string | undefined;
		if (existsSync(manifestPath)) {
			try {
				const mod = (await import(pathToFileURL(manifestPath).href)) as Record<string, unknown>;
				const manifest = mod.default as Record<string, unknown> | undefined;
				cachedVersion = manifest?.version as string | undefined;
			} catch {
				// Can't read manifest — treat as outdated
			}
		}

		// Fetch registry to get latest version
		const registryUrl = `https://raw.githubusercontent.com/jolliai/themes/main/registry.json`;
		const res = await fetch(registryUrl, { headers: githubAuthHeaders() });
		if (!res.ok) return;
		const registry = (await res.json()) as { themes: Array<{ name: string; version: string }> };
		const entry = registry.themes.find((t) => t.name === name);
		if (!entry) return;

		if (cachedVersion && cachedVersion === entry.version) return;

		console.log(`  Updating theme "${name}" (${cachedVersion ?? "unknown"} → ${entry.version})...`);
		await downloadTheme(name, entry.version);
		console.log(`  ✓ Theme "${name}" updated to ${entry.version}`);
	} catch {
		// Network error or download failure — keep cached version
	}
}

// ─── Loaders ──────────────────────────────────────────────────────────────

/**
 * Loads a theme from a file or folder path.
 * If the path is a directory, appends `/index.mjs`.
 */
async function loadFromPath(themePath: string): Promise<ThemePackProvider> {
	const abs = resolve(themePath);
	let entryFile: string;

	if (existsSync(abs) && statSync(abs).isDirectory()) {
		// Folder → look for index.mjs
		entryFile = join(abs, "index.mjs");
		if (!existsSync(entryFile)) {
			throw new Error(`Theme folder "${abs}" does not contain index.mjs`);
		}
	} else {
		entryFile = abs;
	}

	return loadFromModule(pathToFileURL(entryFile).href);
}

/**
 * Dynamically imports a theme module (file URL or npm package name),
 * validates the default export, and registers it.
 */
async function loadFromModule(moduleSpecifier: string): Promise<ThemePackProvider> {
	let mod: Record<string, unknown>;
	try {
		mod = (await import(moduleSpecifier)) as Record<string, unknown>;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to load theme pack "${moduleSpecifier}": ${detail}`);
	}

	const provider = mod.default as ThemePackProvider | undefined;
	if (
		!provider?.manifest?.name ||
		typeof provider.buildCss !== "function" ||
		typeof provider.generateLayout !== "function"
	) {
		throw new Error(
			`Theme pack "${moduleSpecifier}" does not export a valid ThemePackProvider as default export. ` +
				`Expected: { manifest: { name, ... }, buildCss(config), generateLayout(config) }`,
		);
	}

	registerPack(provider);
	return provider;
}

// Keep the old function name as an alias for backward compatibility (tests).
export const loadExternalPack = async (packRef: string, sourceRoot: string) =>
	discoverPack({ title: "", description: "", theme: { pack: packRef } }, { sourceRoot });
export { isExternalPack };

/** Returns `true` when the pack name looks like a path (not a built-in name). */
function isExternalPack(pack: string): boolean {
	return pack.startsWith("./") || pack.startsWith("/") || pack.startsWith("@") || pack.includes("/");
}
