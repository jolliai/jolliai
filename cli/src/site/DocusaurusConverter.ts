/**
 * DocusaurusConverter — I/O wrapper around the pure converter.
 *
 * The pure transform (`convertDocusaurusSidebarObject`, types,
 * `ConversionResult`) lives in `@jolli.ai/site-core`. This module reads
 * the `sidebars.js` file via dynamic `import` and the config file via
 * `readFileSync` (to scan for the favicon path), then hands the result
 * off to the shared converter.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ConversionResult, convertDocusaurusSidebarObject } from "@jolli.ai/site-core";

// Re-export the shared shape so CLI consumers that import `ConversionResult`
// from this file keep working.
export type { ConversionResult } from "@jolli.ai/site-core";

// ─── convertDocusaurusSidebar ────────────────────────────────────────────────

/**
 * Loads a Docusaurus `sidebars.js` file via dynamic import and converts
 * it to Jolli's sidebar overrides + path mappings using the pure
 * transform in `@jolli.ai/site-core`.
 */
export async function convertDocusaurusSidebar(sidebarPath: string): Promise<ConversionResult> {
	const sidebarModule = await loadSidebarFile(sidebarPath);
	return convertDocusaurusSidebarObject(sidebarModule);
}

async function loadSidebarFile(sidebarPath: string): Promise<Record<string, unknown>> {
	try {
		console.log(`  Loading sidebar config: ${sidebarPath}`);
		const fileUrl = pathToFileURL(sidebarPath).href;
		const mod = await import(fileUrl);
		return mod.default ?? mod;
	} catch {
		console.warn(`[jolli] Could not load ${sidebarPath}. Skipping sidebar conversion.`);
		return {};
	}
}

// ─── extractFaviconFromConfig ────────────────────────────────────────────────

/**
 * Reads a Docusaurus config file and extracts the favicon path.
 * Returns a path relative to the docs/ folder (e.g. "../static/img/favicon.ico").
 *
 * Uses simple regex since the config is TypeScript and can't be easily imported.
 */
export function extractFaviconFromConfig(configPath: string): string | undefined {
	try {
		const content = readFileSync(configPath, "utf-8");
		const match = content.match(/favicon\s*:\s*["']([^"']+)["']/);
		if (!match) return undefined;

		// Docusaurus resolves favicon relative to static/ dir
		const faviconRef = match[1]; // e.g. "img/favicon.ico"
		const configDir = dirname(configPath);
		return join(configDir, "static", faviconRef);
	} catch {
		return undefined;
	}
}
