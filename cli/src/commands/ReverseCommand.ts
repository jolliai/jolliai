/**
 * ReverseCommand — `jolli reverse`
 *
 * Reverse-engineers a `site.json` from a Jolli build output.
 *
 * Given a build folder (content/ with _meta.js files) and a source docs
 * folder (human-managed markdown), produces a site.json that, when
 * processed by `jolli dev`, converts the source into the same build output.
 *
 * This is the inverse of the MetaGenerator + ContentMirror pipeline:
 *   - MetaGenerator: site.json sidebar → _meta.js files (forward)
 *   - ReverseCommand: _meta.js files → site.json sidebar (reverse)
 *   - ContentMirror: pathMappings → remap files (forward)
 *   - ReverseCommand: diff source vs build → pathMappings (reverse)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { SidebarItemValue, SidebarOverrides } from "@jolli.ai/site-core";
import type { Command } from "commander";

// ─── Meta file parser (reverse of MetaGenerator.writeMetaFile) ─────────────

interface ParsedMeta {
	[key: string]: string | Record<string, unknown>;
}

/**
 * Reads a `_meta.js` or `_meta.ts` file and parses its `export default`
 * object. This is the reverse of `MetaGenerator.writeMetaFile()`.
 */
function parseMetaFile(filePath: string): ParsedMeta | null {
	const content = readFileSync(filePath, "utf-8");
	const match = content.match(/export default\s*(\{[\s\S]*\})/);
	if (!match) return null;
	try {
		let obj = match[1];
		// Remove trailing commas
		obj = obj.replace(/,(\s*[}\]])/g, "$1");
		// _meta files are trusted build output. Function constructor (not direct
		// eval) so a bundler can statically analyze the call without scope-capture warnings.
		return new Function(`return (${obj})`)() as ParsedMeta;
	} catch {
		return null;
	}
}

/**
 * Walks the build content directory and parses all _meta.js/_meta.ts files.
 * Returns a map of directory path → parsed meta entries.
 */
function collectAllMeta(contentDir: string): Map<string, ParsedMeta> {
	const result = new Map<string, ParsedMeta>();

	function walk(dir: string): void {
		for (const ext of [".ts", ".js"]) {
			const metaPath = join(dir, `_meta${ext}`);
			if (existsSync(metaPath)) {
				const relDir = relative(contentDir, dir).replace(/\\/g, "/");
				const key = relDir === "" ? "/" : `/${relDir}`;
				const parsed = parseMetaFile(metaPath);
				if (parsed) result.set(key, parsed);
				break;
			}
		}
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (
					entry.isDirectory() &&
					!entry.name.startsWith(".") &&
					entry.name !== "node_modules" &&
					entry.name !== "_data"
				) {
					walk(join(dir, entry.name));
				}
			}
		} catch {
			// ignore permission errors
		}
	}

	walk(contentDir);
	return result;
}

// ─── Sidebar extractor (reverse of MetaGenerator.buildOverriddenEntries) ───

/**
 * Converts parsed _meta entries into SidebarOverrides format.
 * Skips `type: "page"` (pages) and `type: "menu"` (header dropdowns)
 * from the root meta — those go into navigation pages and header.items.
 */
function extractSidebar(allMeta: Map<string, ParsedMeta>): SidebarOverrides {
	const sidebar: SidebarOverrides = {};

	for (const [dirPath, entries] of allMeta) {
		const converted: Record<string, SidebarItemValue> = {};

		for (const [key, value] of Object.entries(entries)) {
			// Root-level type:"page" and type:"menu" are extracted separately
			if (dirPath === "/") {
				const v = value as Record<string, unknown>;
				if (v?.type === "page" || v?.type === "menu") continue;
			}

			if (typeof value === "string") {
				converted[key] = value;
			} else if (value && typeof value === "object") {
				const v = value as Record<string, unknown>;
				if (v.display === "hidden") {
					converted[key] = { display: "hidden" } as SidebarItemValue;
				} else if (v.type === "separator") {
					converted[key] = { type: "separator", title: (v.title as string) || key } as SidebarItemValue;
				} else if (v.href) {
					converted[key] = { title: (v.title as string) || key, href: v.href as string };
				} else if (v.title && typeof v.title === "string") {
					converted[key] = v.title;
				}
			}
		}

		if (Object.keys(converted).length > 0) {
			sidebar[dirPath] = converted;
		}
	}

	return sidebar;
}

// ─── Page extractor (reverse of StructureParser.parsePages output) ─────────

interface PageEntry {
	page: string;
	root: string;
}

function extractPages(rootMeta: ParsedMeta): PageEntry[] {
	const pages: PageEntry[] = [];
	for (const [key, value] of Object.entries(rootMeta)) {
		const v = value as Record<string, unknown>;
		if (v?.type === "page") {
			pages.push({
				page: (v.title as string) || key,
				root: `/${key}`,
			});
		}
	}
	return pages;
}

// ─── Header menu extractor (reverse of MetaGenerator.injectRootNavEntries) ─

interface HeaderItem {
	label: string;
	url?: string;
	items?: Array<{ label: string; url: string }>;
}

function extractHeaderItems(rootMeta: ParsedMeta): HeaderItem[] {
	const items: HeaderItem[] = [];
	for (const [, value] of Object.entries(rootMeta)) {
		const v = value as Record<string, unknown>;
		if (v?.type === "menu" && v.items) {
			const subItems = Object.values(v.items as Record<string, { title: string; href: string }>).map((i) => ({
				label: i.title,
				url: i.href,
			}));
			items.push({ label: (v.title as string) || "", items: subItems });
		}
	}
	return items;
}

// ─── PathMappings computer (reverse of ContentMirror.applyPathMapping) ──────

/**
 * Computes pathMappings by comparing source doc dirs to build content dirs.
 * For each build dir that doesn't exist in source, tries to find a source
 * dir whose files overlap — that source dir maps to this build dir.
 */
function computePathMappings(sourceDir: string, contentDir: string): Record<string, string> {
	const mappings: Record<string, string> = {};

	function listDirs(dir: string, base: string): string[] {
		const dirs: string[] = [];
		try {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
					const rel = base ? `${base}/${e.name}` : e.name;
					dirs.push(rel);
					dirs.push(...listDirs(join(dir, e.name), rel));
				}
			}
		} catch {
			// ignore
		}
		return dirs;
	}

	function listFiles(dir: string): Set<string> {
		const files = new Set<string>();
		try {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) {
					files.add(e.name.replace(/\.(md|mdx)$/i, ""));
				}
			}
		} catch {
			// ignore
		}
		return files;
	}

	const sourceDirs = new Set(listDirs(sourceDir, ""));
	const buildDirs = listDirs(contentDir, "");

	for (const buildPath of buildDirs) {
		if (sourceDirs.has(buildPath)) continue; // same name, no mapping

		const buildFiles = listFiles(join(contentDir, buildPath));
		if (buildFiles.size === 0) continue;

		// Find best matching source dir
		let bestMatch = "";
		let bestOverlap = 0;

		for (const srcPath of sourceDirs) {
			const srcFiles = listFiles(join(sourceDir, srcPath));
			if (srcFiles.size === 0) continue;

			const overlap = [...buildFiles].filter((f) => srcFiles.has(f)).length;
			const score = overlap / Math.max(buildFiles.size, srcFiles.size);

			if (score > bestOverlap && score >= 0.6) {
				bestOverlap = score;
				bestMatch = srcPath;
			}
		}

		if (bestMatch && !mappings[bestMatch]) {
			mappings[bestMatch] = buildPath;
		}
	}

	return mappings;
}

// ─── Theme config extractor ────────────────────────────────────────────────

interface ThemeConfig {
	pack: string;
	defaultTheme?: string;
	logoUrl?: string;
	logoUrlDark?: string;
	logoDisplay?: string;
	colors?: { primary: string };
}

function extractThemeConfig(
	buildDir: string,
	themeName: string,
): { theme: ThemeConfig; title: string; description: string } {
	const theme: ThemeConfig = { pack: themeName };
	let title = "Documentation";
	let description = "";

	// Try each theme folder for defaults.jsx
	for (const name of [themeName, "forge", "jolli"]) {
		const defaultsPath = join(buildDir, "app", "themes", name, "defaults.jsx");
		if (!existsSync(defaultsPath)) continue;

		const content = readFileSync(defaultsPath, "utf-8");

		const siteNameMatch = content.match(/SITE_NAME\s*=\s*'([^']+)'/);
		if (siteNameMatch) title = siteNameMatch[1];

		const descMatch = content.match(/SITE_DESCRIPTION\s*=\s*'([^']+)'/);
		if (descMatch) description = descMatch[1];

		const logoMatch = content.match(/LOGO_URL\s*=\s*'([^']+)'/);
		if (logoMatch) theme.logoUrl = logoMatch[1];

		const logoDarkMatch = content.match(/LOGO_URL_DARK\s*=\s*'([^']+)'/);
		if (logoDarkMatch) theme.logoUrlDark = logoDarkMatch[1];

		const displayMatch = content.match(/LOGO_DISPLAY\s*=\s*'([^']+)'/);
		if (displayMatch) theme.logoDisplay = displayMatch[1];

		const accentMatch = content.match(/ACCENT_COLOR\s*=\s*'([^']+)'/);
		if (accentMatch) theme.colors = { primary: accentMatch[1] };

		const themeMatch = content.match(/DEFAULT_THEME\s*=\s*'([^']+)'/);
		if (themeMatch) theme.defaultTheme = themeMatch[1];

		break;
	}

	return { theme, title, description };
}

// ─── Footer extractor ──────────────────────────────────────────────────────

function extractFooter(buildDir: string): Record<string, unknown> {
	const footer: Record<string, unknown> = {};

	for (const name of ["forge", "jolli"]) {
		const defaultsPath = join(buildDir, "app", "themes", name, "defaults.jsx");
		if (!existsSync(defaultsPath)) continue;

		const content = readFileSync(defaultsPath, "utf-8");

		const copyrightMatch = content.match(/FOOTER_COPYRIGHT\s*=\s*'([^']*)'/);
		if (copyrightMatch?.[1]) footer.copyright = copyrightMatch[1];

		// Extract FOOTER_COLUMNS
		const colsMatch = content.match(/FOOTER_COLUMNS\s*=\s*(\[[\s\S]*?\])\s*\n\n/);
		if (colsMatch) {
			try {
				// Trusted build output. Function constructor (not direct eval) so
				// a bundler can statically analyze the call without scope-capture warnings.
				const cols = new Function(`return (${colsMatch[1]})`)() as Array<{
					title: string;
					links: Array<{ label: string; url: string }>;
				}>;
				if (Array.isArray(cols) && cols.length > 0) {
					footer.columns = cols.map((col) => ({
						title: col.title,
						links: col.links.map((l) => ({ label: l.label, url: l.url })),
					}));
				}
			} catch {
				// ignore parse errors
			}
		}

		// Extract FOOTER_SOCIAL_LINKS
		const socialMatch = content.match(/FOOTER_SOCIAL_LINKS\s*=\s*(\{[\s\S]*?\})\s*\n/);
		if (socialMatch) {
			try {
				// Trusted build output. Function constructor (not direct eval) so
				// a bundler can statically analyze the call without scope-capture warnings.
				const social = new Function(`return (${socialMatch[1]})`)() as Record<string, string>;
				const socialLinks: Record<string, string> = {};
				for (const [key, value] of Object.entries(social)) {
					if (value) socialLinks[key] = value;
				}
				if (Object.keys(socialLinks).length > 0) {
					footer.socialLinks = socialLinks;
				}
			} catch {
				// ignore
			}
		}

		break;
	}

	return footer;
}

// ─── Register command ──────────────────────────────────────────────────────

export function registerReverseCommand(program: Command): void {
	program
		.command("reverse")
		.description("Reverse-engineer a site.json from a Jolli build output")
		.argument("<build-dir>", "Path to the build output folder (with content/ and app/)")
		.argument("<source-dir>", "Path to the human-managed source docs folder")
		.option("--theme <name>", "Theme name to set in the generated site.json", "default")
		.option("--output <path>", "Output path for the generated site.json")
		.action(async (buildDirArg: string, sourceDirArg: string, opts: { theme: string; output?: string }) => {
			const buildDir = resolve(buildDirArg);
			const sourceDir = resolve(sourceDirArg);
			const outputPath = opts.output ? resolve(opts.output) : join(sourceDir, "site.json");
			const contentDir = join(buildDir, "content");

			if (!existsSync(contentDir)) {
				console.error(`  Error: No content/ folder found in: ${buildDir}`);
				process.exitCode = 1;
				return;
			}
			if (!existsSync(sourceDir)) {
				console.error(`  Error: Source folder not found: ${sourceDir}`);
				process.exitCode = 1;
				return;
			}

			console.log(`  Build:  ${buildDir}`);
			console.log(`  Source: ${sourceDir}`);
			console.log(`  Theme:  ${opts.theme}`);
			console.log("");

			// Step 1: Parse all _meta files
			console.log("  Parsing build _meta files...");
			const allMeta = collectAllMeta(contentDir);
			console.log(`  ✓ Found ${allMeta.size} _meta files`);

			const rootMeta = allMeta.get("/") || {};

			// Step 2: Extract pages
			const pages = extractPages(rootMeta);
			if (pages.length > 0) {
				console.log(`  ✓ Pages: ${pages.map((p) => p.page).join(", ")}`);
			}

			// Step 3: Extract header items
			const headerItems = extractHeaderItems(rootMeta);
			if (headerItems.length > 0) {
				console.log(`  ✓ Header menus: ${headerItems.map((h) => h.label).join(", ")}`);
			}

			// Step 4: Build sidebar
			const sidebar = extractSidebar(allMeta);
			console.log(`  ✓ Sidebar: ${Object.keys(sidebar).length} paths`);

			// Step 5: Compute pathMappings
			console.log("  Computing pathMappings...");
			const pathMappings = computePathMappings(sourceDir, contentDir);
			console.log(`  ✓ PathMappings: ${Object.keys(pathMappings).length} entries`);
			for (const [from, to] of Object.entries(pathMappings)) {
				console.log(`    ${from} → ${to}`);
			}

			// Step 6: Extract theme config
			const { theme, title, description } = extractThemeConfig(buildDir, opts.theme);
			console.log(`  ✓ Title: ${title}`);

			// Step 7: Extract footer
			const footer = extractFooter(buildDir);

			// Step 8: Assemble site.json
			const siteJson: Record<string, unknown> = {
				title,
				description,
				theme,
				nav: [],
			};

			if (headerItems.length > 0) {
				siteJson.header = { items: headerItems };
			}

			if (Object.keys(footer).length > 0) {
				siteJson.footer = footer;
			}

			if (pages.length > 0) {
				siteJson.navigation = pages;
			}

			if (Object.keys(sidebar).length > 0) {
				siteJson.sidebar = sidebar;
			}

			if (Object.keys(pathMappings).length > 0) {
				siteJson.pathMappings = pathMappings;
			}

			// Step 9: Write output
			const output = JSON.stringify(siteJson, null, 2);
			await writeFile(outputPath, `${output}\n`, "utf-8");

			console.log("");
			console.log(`  ✓ Generated ${outputPath} (${output.length} bytes)`);
			console.log("");
			console.log("  To build the site:");
			console.log(`    jolli dev ${sourceDir} --theme <theme-path>`);
		});
}
