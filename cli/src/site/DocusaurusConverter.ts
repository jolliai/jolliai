/**
 * DocusaurusConverter — converts a Docusaurus `sidebars.js` file into
 * jolli's `SidebarOverrides` + `PathMappings` for `site.json`.
 *
 * The sidebar defines the LOGICAL navigation structure. When it differs from
 * the physical folder structure (e.g. `sql/` grouped under `pipelines`),
 * pathMappings records how to remap files so the content/ directory matches
 * the sidebar's logical structure.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PathMappings, SidebarItemValue, SidebarOverrides } from "./Types.js";

// ─── Docusaurus sidebar types (subset) ───────────────────────────────────────

type DocSidebarItem = string | DocCategory | DocDoc | DocLink;

interface DocCategory {
	type: "category";
	label: string;
	items: DocSidebarItem[];
	link?: { type: string; id?: string };
}

interface DocDoc {
	type: "doc";
	id: string;
	label?: string;
}

interface DocLink {
	type: "link";
	label: string;
	href: string;
}

// ─── ConversionResult ────────────────────────────────────────────────────────

export interface ConversionResult {
	sidebar: SidebarOverrides;
	pathMappings: PathMappings;
	favicon?: string;
}

// ─── convertDocusaurusSidebar ────────────────────────────────────────────────

/**
 * Loads a Docusaurus `sidebars.js` file and converts it to sidebar overrides
 * and path mappings.
 *
 * The sidebar overrides define the logical navigation structure.
 * The path mappings tell ContentMirror how to remap source folders to match
 * the sidebar's logical structure.
 */
export async function convertDocusaurusSidebar(sidebarPath: string): Promise<ConversionResult> {
	const sidebarModule = await loadSidebarFile(sidebarPath);

	const sidebarEntries = Object.values(sidebarModule);
	const items = sidebarEntries.find((v) => Array.isArray(v)) as DocSidebarItem[] | undefined;

	if (!items) {
		console.warn("[jolli] Could not find sidebar items in the Docusaurus config.");
		return { sidebar: {}, pathMappings: {} };
	}

	const sidebar = new Map<string, [string, SidebarItemValue][]>();
	const pathMappings: PathMappings = {};

	collectEntries(items, "/", sidebar, pathMappings);

	// Convert Map to SidebarOverrides
	const sidebarResult: SidebarOverrides = {};
	for (const [dirPath, entries] of sidebar) {
		const obj: Record<string, SidebarItemValue> = {};
		for (const [key, value] of entries) {
			obj[key] = value;
		}
		sidebarResult[dirPath] = obj;
	}

	return { sidebar: sidebarResult, pathMappings };
}

// ─── loadSidebarFile ─────────────────────────────────────────────────────────

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

// ─── collectEntries ──────────────────────────────────────────────────────────

/**
 * Walks the Docusaurus sidebar tree. Entries are placed into the sidebar
 * at their LOGICAL position (matching the sidebar hierarchy). When a
 * category's actual filesystem path differs from its logical path,
 * a pathMapping is recorded.
 *
 * @param items       - Docusaurus sidebar items
 * @param logicalDir  - The logical directory path in the sidebar tree (e.g. "/pipelines")
 * @param sidebar     - Sidebar entries being built
 * @param pathMappings - Path remappings being built
 */
function collectEntries(
	items: DocSidebarItem[],
	logicalDir: string,
	sidebar: Map<string, [string, SidebarItemValue][]>,
	pathMappings: PathMappings,
): void {
	for (const item of items) {
		if (typeof item === "string") {
			const key = lastSegment(item);
			addSidebarEntry(sidebar, logicalDir, key, toTitleCase(key));
			addDocPathMapping(item, logicalDir, pathMappings);
		} else if (item.type === "doc") {
			const key = lastSegment(item.id);
			addSidebarEntry(sidebar, logicalDir, key, item.label ?? toTitleCase(key));
			addDocPathMapping(item.id, logicalDir, pathMappings);
		} else if (item.type === "category") {
			const actualDir = resolveCategoryActualDir(item);
			const parentActualDir = logicalToActualDir(logicalDir, pathMappings);

			// If this category's actual dir is the same as the parent's,
			// it's a virtual grouping (e.g. "Operations" inside sql/).
			// Don't create a subfolder — just add items to the parent dir.
			if (actualDir === parentActualDir) {
				collectEntries(item.items, logicalDir, sidebar, pathMappings);
				continue;
			}

			const catKey = resolveCategoryKey(item);

			// Add category to current logical dir's sidebar
			addSidebarEntry(sidebar, logicalDir, catKey, item.label);

			// The logical path for children
			const logicalChildDir = logicalDir === "/" ? `/${catKey}` : `${logicalDir}/${catKey}`;

			// If actual filesystem dir differs from logical dir, record mapping
			const actualRel = actualDir.slice(1);
			const logicalRel = logicalChildDir.slice(1);

			if (actualRel && logicalRel && actualRel !== logicalRel) {
				pathMappings[actualRel] = logicalRel;
			}

			// Recurse — children go into logical child dir
			collectEntries(item.items, logicalChildDir, sidebar, pathMappings);
		} else if (item.type === "link") {
			const key = slugify(item.label);
			addSidebarEntry(sidebar, logicalDir, key, {
				title: item.label,
				href: item.href.replace(/^pathname:\/\//, ""),
			});
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function addSidebarEntry(
	sidebar: Map<string, [string, SidebarItemValue][]>,
	dirPath: string,
	key: string,
	value: SidebarItemValue,
): void {
	if (!sidebar.has(dirPath)) {
		sidebar.set(dirPath, []);
	}
	const entries = sidebar.get(dirPath) ?? [];
	if (!entries.some(([k]) => k === key)) {
		entries.push([key, value]);
	}
}

/** Gets the last path segment, handling "index" specially. */
function lastSegment(docId: string): string {
	const parts = docId.split("/");
	const last = parts[parts.length - 1];
	if (last === "index" && parts.length > 1) {
		return parts[parts.length - 2];
	}
	return last;
}

/**
 * Determines the sidebar key for a category.
 * Uses link.id, first item's path prefix, or slugified label.
 */
function resolveCategoryKey(cat: DocCategory): string {
	// Use the last segment of the actual filesystem directory.
	// This determines what folder name this category maps to.
	const actualDir = resolveCategoryActualDir(cat);
	const segments = actualDir.split("/").filter(Boolean);
	return segments[segments.length - 1] || slugify(cat.label);
}

/**
 * Determines the ACTUAL filesystem directory for a category
 * (from its link.id or first item's path).
 */
function resolveCategoryActualDir(cat: DocCategory): string {
	if (cat.link?.id) {
		// link.id is a doc path like "use_cases/batch/intro" or "tutorials/basics/index"
		// The directory is everything except the last segment (the filename)
		const parts = cat.link.id.split("/");
		parts.pop(); // Remove the filename (intro, index, etc.)
		if (parts.length > 0) return `/${parts.join("/")}`;
	}
	const firstItem = cat.items[0];
	if (typeof firstItem === "string") {
		const parts = firstItem.split("/");
		if (parts.length > 1) return `/${parts.slice(0, -1).join("/")}`;
	} else if (firstItem && "id" in firstItem && firstItem.id) {
		const parts = firstItem.id.split("/");
		if (parts.length > 1) return `/${parts.slice(0, -1).join("/")}`;
	}
	return `/${slugify(cat.label)}`;
}

/**
 * Converts a logical dir path back to the actual filesystem dir using
 * known path mappings. Used to detect virtual groupings.
 */
function logicalToActualDir(logicalDir: string, pathMappings: PathMappings): string {
	const logicalRel = logicalDir.slice(1); // Strip leading "/"
	if (!logicalRel) return "/";

	// Check if any mapping target matches this logical dir
	for (const [source, target] of Object.entries(pathMappings)) {
		if (target === logicalRel) return `/${source}`;
	}

	return logicalDir;
}

/**
 * For a doc ID like "use_cases/fraud_detection/fraud_detection" in logical dir "/tutorials",
 * checks if the doc's actual parent directory is outside the logical dir.
 * If so, adds a folder-level pathMapping.
 *
 * Only generates mappings when the doc's actual path is in a DIFFERENT
 * top-level directory than the logical dir expects. This avoids false
 * mappings for docs that are already in the correct directory.
 */
function addDocPathMapping(docId: string, logicalDir: string, pathMappings: PathMappings): void {
	const parts = docId.split("/");
	if (parts.length < 2) return; // Root-level doc, no remapping needed

	const actualDir = parts.slice(0, -1).join("/"); // "use_cases/fraud_detection"
	const logicalDirRel = logicalDir.slice(1); // "tutorials"

	// Check if the doc's actual path starts with the logical dir
	// If it does, the doc is already where it should be — no mapping needed
	if (!logicalDirRel || actualDir === logicalDirRel || actualDir.startsWith(`${logicalDirRel}/`)) {
		return;
	}

	// The doc is in a different directory — add folder mapping
	if (!pathMappings[actualDir]) {
		const folderName = parts[parts.length - 2]; // "fraud_detection"
		const logicalTarget = logicalDirRel ? `${logicalDirRel}/${folderName}` : folderName;
		pathMappings[actualDir] = logicalTarget;
	}
}

function slugify(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function toTitleCase(key: string): string {
	return key.replace(/[-_]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
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
