/**
 * SiteJsonReader — reads and validates `site.json` from the Source_Root.
 *
 * When `site.json` is absent:
 *   1. Detects documentation framework config files (Docusaurus, etc.)
 *   2. If found, prompts user to migrate sidebar config
 *   3. Prompts for site title
 *   4. Writes `site.json` to the source root
 *
 * When `site.json` exists: reads and parses it.
 * Throws a descriptive error if the file exists but is not valid JSON.
 * Silently ignores unrecognized fields.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { type ConversionResult, convertDocusaurusSidebar, extractFaviconFromConfig } from "./DocusaurusConverter.js";
import { detectFramework, promptMigration } from "./FrameworkDetector.js";
import type { SiteJson } from "./Types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SiteJsonResult {
	config: SiteJson;
	usedDefault: boolean;
}

// ─── Default configuration ────────────────────────────────────────────────────

export const DEFAULT_SITE_JSON: SiteJson = {
	title: "My Documentation Site",
	description: "A documentation site powered by Jolli",
	nav: [],
};

// ─── promptSiteTitle ─────────────────────────────────────────────────────────

/**
 * Prompts the user for a site title. If the user presses Enter without
 * typing anything, returns `defaultTitle`.
 */
function promptSiteTitle(defaultTitle: string): Promise<string> {
	if (!process.stdin.isTTY) return Promise.resolve(defaultTitle);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`Site title (${defaultTitle}): `, (answer) => {
			rl.close();
			const trimmed = answer.trim();
			resolve(trimmed || defaultTitle);
		});
	});
}

// ─── readSiteJson ─────────────────────────────────────────────────────────────

/**
 * Reads `site.json` from `sourceRoot`.
 *
 * @param sourceRoot - Path to the content folder
 * @param options.migrate - If true, force re-detection even if site.json exists
 */
export async function readSiteJson(sourceRoot: string, options?: { migrate?: boolean }): Promise<SiteJsonResult> {
	const filePath = join(sourceRoot, "site.json");

	// If site.json exists and not forcing migration, read it
	if (existsSync(filePath) && !options?.migrate) {
		return readExistingSiteJson(filePath);
	}

	// site.json missing (or --migrate): detect framework and create
	return createSiteJson(sourceRoot, filePath);
}

// ─── readExistingSiteJson ────────────────────────────────────────────────────

async function readExistingSiteJson(filePath: string): Promise<SiteJsonResult> {
	const raw = await readFile(filePath, "utf-8");

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${filePath}: ${detail}`);
	}

	const obj = parsed as Record<string, unknown>;

	const config: SiteJson = {
		title: typeof obj.title === "string" ? obj.title : DEFAULT_SITE_JSON.title,
		description: typeof obj.description === "string" ? obj.description : DEFAULT_SITE_JSON.description,
		nav: Array.isArray(obj.nav) ? (obj.nav as SiteJson["nav"]) : DEFAULT_SITE_JSON.nav,
		...Object.fromEntries(Object.entries(obj).filter(([k]) => !["title", "description", "nav"].includes(k))),
	};

	coerceBrandingToTheme(config);
	coerceFooterSocialAlias(config);

	return { config, usedDefault: false };
}

// ─── Schema aliasing ─────────────────────────────────────────────────────────

/**
 * Migrates the SaaS `branding.*` shape into the canonical `theme.*` block so
 * downstream code only ever reads `theme`. `theme.*` wins when both are set —
 * a single-field override on top of a `branding` block keeps working without
 * forcing the customer to rewrite the whole block.
 *
 * Mapping (every field is optional):
 *   - `branding.themePack`           → `theme.pack`
 *   - `branding.colors.primaryHue`   → `theme.primaryHue`
 *   - `branding.fontFamily`          → `theme.fontFamily`
 *   - `branding.defaultTheme`        → `theme.defaultTheme`
 *   - `branding.favicon`             → `theme.favicon`
 *   - `branding.logo.image`          → `theme.logoUrl`
 *   - `branding.logo.imageDark`      → `theme.logoUrlDark`
 *   - `branding.logo.text`           → `theme.logoText`
 *   - `branding.logo.display`        → `theme.logoDisplay`
 *
 * `branding.logo.alt` is intentionally dropped — the CLI renderer derives
 * `<img alt>` from the title/logoText, and there's no plumbed-through
 * customization point for an explicit alt string yet.
 *
 * Mutates `config.theme` in place. Leaves `config.branding` intact so a
 * follow-up reader can inspect it for diagnostics — downstream code should
 * not read `branding` directly.
 */
function coerceBrandingToTheme(config: SiteJson): void {
	const branding = config.branding;
	if (!branding) return;

	const existing = config.theme ?? {};
	const merged = { ...existing };

	if (branding.themePack !== undefined && merged.pack === undefined) {
		merged.pack = branding.themePack;
	}
	if (branding.favicon !== undefined && merged.favicon === undefined) {
		merged.favicon = branding.favicon;
	}
	if (branding.fontFamily !== undefined && merged.fontFamily === undefined) {
		merged.fontFamily = branding.fontFamily;
	}
	if (branding.defaultTheme !== undefined && merged.defaultTheme === undefined) {
		merged.defaultTheme = branding.defaultTheme;
	}
	if (branding.colors?.primaryHue !== undefined && merged.primaryHue === undefined) {
		merged.primaryHue = branding.colors.primaryHue;
	}
	if (branding.logo) {
		if (branding.logo.image !== undefined && merged.logoUrl === undefined) {
			merged.logoUrl = branding.logo.image;
		}
		if (branding.logo.imageDark !== undefined && merged.logoUrlDark === undefined) {
			merged.logoUrlDark = branding.logo.imageDark;
		}
		if (branding.logo.text !== undefined && merged.logoText === undefined) {
			merged.logoText = branding.logo.text;
		}
		if (branding.logo.display !== undefined && merged.logoDisplay === undefined) {
			merged.logoDisplay = branding.logo.display;
		}
	}

	config.theme = merged;
}

/**
 * Migrates `footer.social` (SaaS schema) into `footer.socialLinks` (CLI
 * canonical). `socialLinks` wins if both are set.
 */
function coerceFooterSocialAlias(config: SiteJson): void {
	if (!config.footer) return;
	if (config.footer.social && !config.footer.socialLinks) {
		config.footer.socialLinks = config.footer.social;
	}
}

// ─── createSiteJson ──────────────────────────────────────────────────────────

async function createSiteJson(sourceRoot: string, filePath: string): Promise<SiteJsonResult> {
	let conversion: ConversionResult | undefined;

	// Step 1: Detect framework
	const framework = detectFramework(sourceRoot);

	if (framework) {
		// Step 2: Prompt for migration
		const shouldMigrate = await promptMigration(framework);

		if (shouldMigrate && framework.name === "docusaurus" && framework.sidebarPath) {
			try {
				conversion = await convertDocusaurusSidebar(framework.sidebarPath);
				// Extract favicon from docusaurus config
				const faviconPath = extractFaviconFromConfig(framework.configPath);
				if (faviconPath) {
					conversion.favicon = faviconPath;
				}
				console.log(`  Converted ${framework.sidebarPath} → sidebar config`);
			} catch (err) {
				console.warn(
					`[jolli] Warning: Failed to convert sidebar: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else if (shouldMigrate && framework.name !== "docusaurus") {
			console.warn(`[jolli] ${framework.name} conversion is not yet supported. Using folder structure.`);
		}
	}

	// Step 3: Prompt for site title
	const folderName = basename(sourceRoot);
	const defaultTitle = folderName.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	const title = await promptSiteTitle(defaultTitle);

	// Step 4: Build and write site.json
	const config: SiteJson = {
		...DEFAULT_SITE_JSON,
		title,
		description: `${title} documentation`,
	};

	if (conversion?.sidebar && Object.keys(conversion.sidebar).length > 0) {
		config.sidebar = conversion.sidebar;
	}
	if (conversion?.pathMappings && Object.keys(conversion.pathMappings).length > 0) {
		config.pathMappings = conversion.pathMappings;
	}
	if (conversion?.favicon) {
		config.favicon = conversion.favicon;
	}

	await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	console.log(`  Created ${filePath}`);

	return { config, usedDefault: true };
}
