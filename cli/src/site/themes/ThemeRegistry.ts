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
 *   5. GitHub registry → github.com/jolliai/themes/<name>/
 *
 * npm package references (e.g. `@acme/docs-theme`) were once a supported
 * resolution mode but were removed in commit d55ec46. They are now
 * intercepted between step 4 and step 5 with a migration error instead of
 * being passed to the GitHub registry, which only handles single-segment
 * names.
 */

import { existsSync, statSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DefaultThemeMode, FontFamily } from "@jolli.ai/site-core";
import type { NextraProjectConfig } from "../NextraProjectWriter.js";

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
 * Stable phrase that the npm-package guard emits in its `console.error`.
 * Exported so tests can assert on it without hard-coding the surrounding
 * sentence — change the wording around it freely, but keep this tag intact
 * (or update its tests when intentionally changing the contract).
 */
export const NPM_PACKAGE_GUARD_TAG = "looks like an npm package reference";

/**
 * Discovers and loads a theme pack by name, searching in order:
 *   1. `--theme` CLI path (passed as `themePath`) — always wins
 *   2. Registry (packs registered at runtime)
 *   3. Explicit file path in site.json (starts with `./` or `/`)
 *   4. User theme directory (`~/.jolli/themes/<name>/index.mjs`)
 *   5. GitHub registry (`github.com/jolliai/themes/<name>/`)
 *
 * Between step 4 and step 5, names that look like npm package references
 * (start with `@` or contain `/`) short-circuit with a migration error
 * instead of being handed to the GitHub registry.
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

	// "default" is a sentinel meaning "vanilla Nextra layout, no pack" — when
	// no pack with this name has been registered, every step below is
	// guaranteed to miss (the user themes dir is not auto-created, no
	// `jolli-theme-default` / `@jolli/theme-default` package exists, and the
	// GitHub themes repo has no `default/` subfolder). Short-circuiting here
	// saves a guaranteed-failing GitHub round-trip per call and lets
	// `initNextraProject` fall straight through to the built-in layout.
	//
	// Placed AFTER the registry lookup so that a user-registered pack named
	// "default" still wins — the registry stays the source of truth, and
	// `discoverPack` / `resolvePack` agree on the resolved provider.
	if (name === "default") return undefined;

	// 3) Explicit file path in site.json — accept POSIX-style absolutes
	// (`/...`), Windows absolutes (`C:\…`, `\\server\share\…`), and the
	// `./` / `../` relative-prefix conventions that work on both.
	if (isAbsolute(name) || name.startsWith("./") || name.startsWith("../")) {
		const abs = isAbsolute(name) ? name : resolve(options?.sourceRoot ?? process.cwd(), name);
		return loadFromPath(abs);
	}

	// 4) User theme directory: ~/.jolli/themes/<name>/
	//    Check if a newer version is available on GitHub and update if so.
	const userThemePath = join(USER_THEMES_DIR, name);
	if (existsSync(userThemePath)) {
		await checkAndUpdateCachedTheme(name, userThemePath);
		return loadFromPath(userThemePath);
	}

	// Guard: npm package references (e.g. `@acme/docs-theme` or
	// `acme/docs-theme`) used to be a supported resolution mode but were
	// removed in commit d55ec46. `ThemePack` is still `(string & {})` so
	// existing site.json values type-check; without this guard they would
	// fall through to the GitHub registry, which expects single-segment
	// names like "forge" and would fail with an opaque
	// "could not load theme" message. Surface the migration path
	// explicitly and bail before the network call.
	//
	// IMPORTANT: this guard MUST stay above the GitHub registry call below.
	// Moving it down (e.g. when refactoring `downloadTheme` to a static
	// import) would let npm-style names hit the network and produce the
	// opaque error this guard was added to prevent.
	if (looksLikeNpmPackage(name)) {
		console.error(
			`  Error: theme.pack "${name}" ${NPM_PACKAGE_GUARD_TAG}, but npm package theme packs ` +
				`are no longer supported.\n` +
				`         Migrate to one of:\n` +
				`           • A theme name published to github.com/jolliai/themes (e.g. "forge", "atlas")\n` +
				`           • A local file or folder path (starts with "./" or "/")\n` +
				`           • The built-in "default" theme (vanilla nextra-theme-docs)\n` +
				`         Falling back to the default Nextra layout.`,
		);
		return undefined;
	}

	// 5) GitHub registry: github.com/jolliai/themes/<name>/
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

/**
 * Returns `true` when `name` looks like an npm package reference rather than
 * a GitHub theme registry name. By the time `discoverPack` calls this, the
 * `./` and `/` path forms have already been resolved by step 3, so any
 * remaining string containing `/` or starting with `@` is a strong signal
 * of an npm-style reference (scoped or unscoped).
 *
 * Path forms in `site.json` are expected to use forward slashes. Windows-
 * style absolute paths like `C:\\Users\\foo\\theme` are not detected by
 * step 3 (which checks `./` / `/` prefixes) and will also slip past this
 * guard (no `/`, no leading `@`), falling through to the GitHub registry.
 * Users on Windows should write `C:/Users/foo/theme` or use a `./` relative
 * path instead.
 *
 * Exported for unit testing — call site is in `discoverPack`.
 */
export function looksLikeNpmPackage(name: string): boolean {
	return name.startsWith("@") || name.includes("/");
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

		// Read cached version from manifest.mjs via text parse — do NOT use
		// `await import(manifestPath)` here. Node ESM caches modules by URL, and
		// the relative `import "./manifest.mjs"` inside the theme's index.mjs
		// resolves to the same file URL. If we imported it now and `downloadTheme`
		// then overwrote the file, the freshly-loaded index.mjs would still bind
		// to the cached stale manifest module — leaving the in-process theme
		// advertising the new buildCss/generateLayout next to old manifest
		// fields (name, version, supports, defaults).
		const manifestPath = join(_cachedPath, "manifest.mjs");
		const cachedVersion = await readManifestVersion(manifestPath);

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
		// If the theme's index.mjs / css.mjs / layout.mjs were imported earlier
		// in this process (long-running `jolli dev`), Node's ESM cache keeps
		// serving the previously-loaded copies — the disk update can't take
		// effect until the process restarts. Tell the user explicitly so a
		// successful "Updated to X.Y.Z" message isn't misleading.
		console.log(`  ↻ Restart the current process to apply the updated theme.`);
	} catch {
		// Network error or download failure — keep cached version
	}
}

/**
 * Reads the `version` field from a theme's `manifest.mjs` via a text scan.
 * Intentionally avoids `import()` so the file URL stays out of Node's ESM
 * module cache — see the comment in `checkAndUpdateCachedTheme` for why.
 *
 * Returns `undefined` when the file is missing, unreadable, or has no
 * `version: "..."` literal. The caller treats `undefined` as "outdated" and
 * triggers a fresh download.
 *
 * Exported for unit testing — call site is in `checkAndUpdateCachedTheme`.
 */
export async function readManifestVersion(manifestPath: string): Promise<string | undefined> {
	try {
		const text = await readFile(manifestPath, "utf-8");
		const match = text.match(/version\s*:\s*["']([^"']+)["']/);
		return match?.[1];
	} catch {
		return undefined;
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
 * Dynamically imports a theme module from a file URL,
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
