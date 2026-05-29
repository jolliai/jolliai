/**
 * DocusaurusConverter (pure half).
 *
 * Transforms a parsed Docusaurus `sidebars.js` module shape into Jolli's
 * `SidebarOverrides` + `PathMappings`. The file-loading side (dynamic
 * `import` of `sidebars.js` + favicon regex against the config file)
 * lives in `cli/src/site/DocusaurusConverter.ts`.
 *
 * The web tool calls `convertDocusaurusSidebarObject` directly, passing a
 * sidebar module it loaded through its own mechanism (uploaded file
 * eval, repo fetch, etc.) without needing Node's filesystem.
 */

import type { PathMappings, SidebarItemValue, SidebarOverrides } from "./Types.js";

// ─── Docusaurus sidebar types (subset) ───────────────────────────────────────

export type DocSidebarItem = string | DocCategory | DocDoc | DocLink;

export interface DocCategory {
	type: "category";
	label: string;
	items: DocSidebarItem[];
	link?: { type: string; id?: string };
}

export interface DocDoc {
	type: "doc";
	id: string;
	label?: string;
}

export interface DocLink {
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

// ─── convertDocusaurusSidebarObject ──────────────────────────────────────────

/**
 * Converts a loaded Docusaurus sidebar module (the shape `import("./sidebars.js")`
 * returns) into Jolli's sidebar + path-mapping overrides. The first array-
 * valued field is treated as the sidebar items list — Docusaurus configs
 * conventionally export a single `sidebar` map, but a few projects use a
 * named export instead.
 *
 * Returns `{ sidebar: {}, pathMappings: {} }` (with a `console.warn`) when
 * no array field is found.
 */
export function convertDocusaurusSidebarObject(sidebarModule: Record<string, unknown>): ConversionResult {
	const sidebarEntries = Object.values(sidebarModule);
	const items = sidebarEntries.find((v) => Array.isArray(v)) as DocSidebarItem[] | undefined;

	if (!items) {
		console.warn("[jolli] Could not find sidebar items in the Docusaurus config.");
		return { sidebar: {}, pathMappings: {} };
	}

	const sidebar = new Map<string, [string, SidebarItemValue][]>();
	const pathMappings: PathMappings = {};

	collectEntries(items, "/", sidebar, pathMappings);

	// Convert Map → SidebarOverrides
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

// ─── collectEntries ──────────────────────────────────────────────────────────

/**
 * Walks the Docusaurus sidebar tree. Entries are placed into the sidebar
 * at their LOGICAL position (matching the sidebar hierarchy). When a
 * category's actual filesystem path differs from its logical path,
 * a pathMapping is recorded.
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
	/* v8 ignore start -- defensive: `has` above guarantees `get` returns the array */
	const entries = sidebar.get(dirPath) ?? [];
	/* v8 ignore stop */
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
		/* v8 ignore start -- defensive: `!logicalDirRel` guard above already returned */
		const logicalTarget = logicalDirRel ? `${logicalDirRel}/${folderName}` : folderName;
		/* v8 ignore stop */
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
