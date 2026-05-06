/**
 * MetaGenerator — generates `_meta.js` files for Nextra v4 navigation.
 *
 * For every folder in the content directory that contains at least one markdown
 * file, OpenAPI-derived `.mdx` file, or non-empty subfolder, a `_meta.js` is
 * written.
 *
 * When sidebar overrides are provided (from `site.json`), declared items are
 * written in declaration order with their custom labels/values. Nextra
 * automatically appends unlisted filesystem items in alphabetical order.
 *
 * Without overrides, all items are listed alphabetically with auto-generated
 * title-cased labels (backward-compatible default behavior).
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { SidebarItemValue, SidebarOverrides } from "./Types.js";

// ─── MetaEntry ────────────────────────────────────────────────────────────────

/** A single entry in a `_meta.js` navigation file. */
export interface MetaEntry {
	/** Filename without extension — used as the Nextra navigation key. */
	key: string;
	/** Display label (string) or Nextra meta object (for links, hidden items, etc.). */
	value: string | Record<string, unknown>;
}

// ─── toTitleCase ──────────────────────────────────────────────────────────────

/**
 * Converts a filename (without extension) into a human-readable title.
 *
 * - Replaces all hyphens (`-`) and underscores (`_`) with spaces.
 * - Capitalises the first letter of every word.
 */
export function toTitleCase(filename: string): string {
	return filename.replace(/[-_]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// ─── buildMetaEntries ─────────────────────────────────────────────────────────

/**
 * Builds an array of `MetaEntry` objects from a list of filenames (or
 * directory names), optionally applying sidebar overrides.
 *
 * **Without overrides**: entries are sorted alphabetically, labels are
 * title-cased. `index.md` / `index.mdx` gets label `"Home"`.
 *
 * **With overrides**: declared items come first in declaration order with
 * their custom values. Remaining filesystem items are NOT included — Nextra
 * will auto-append them alphabetically at runtime.
 */
export function buildMetaEntries(filenames: string[], override?: Record<string, SidebarItemValue>): MetaEntry[] {
	if (override) {
		return buildOverriddenEntries(filenames, override);
	}
	return buildDefaultEntries(filenames);
}

/**
 * Default behavior: all items alphabetically sorted with auto-generated labels.
 */
function buildDefaultEntries(filenames: string[]): MetaEntry[] {
	const seen = new Set<string>();
	const entries: MetaEntry[] = [];

	for (const filename of filenames) {
		const ext = extname(filename);
		const key = ext ? basename(filename, ext) : filename;

		// Hide index files from sidebar — they serve as the folder's own page.
		// Using display: "hidden" prevents Nextra from auto-appending them
		// as visible children while still allowing them to be the folder page.
		if (key === "index") {
			entries.push({ key, value: { display: "hidden" } });
			seen.add(key);
			continue;
		}

		if (seen.has(key)) continue;
		seen.add(key);

		entries.push({ key, value: toTitleCase(key) });
	}

	entries.sort((a, b) => a.key.localeCompare(b.key));
	return entries;
}

/**
 * Override behavior: declared items in declaration order, with custom values.
 * Items declared in the override that don't exist on the filesystem are
 * included (they may be external links or separators).
 */
function buildOverriddenEntries(filenames: string[], override: Record<string, SidebarItemValue>): MetaEntry[] {
	const entries: MetaEntry[] = [];

	// If the folder has an index file but the override doesn't mention it,
	// add it as hidden to prevent Nextra from showing it as a duplicate child.
	const hasIndexFile = filenames.some((f) => {
		const ext = extname(f);
		const key = ext ? basename(f, ext) : f;
		return key === "index";
	});
	if (hasIndexFile && !override.index) {
		entries.push({ key: "index", value: { display: "hidden" } });
	}

	// Declared items in declaration order
	for (const [key, value] of Object.entries(override)) {
		if (typeof value === "string") {
			entries.push({ key, value });
		} else {
			entries.push({ key, value: value as Record<string, unknown> });
		}
	}

	return entries;
}

// ─── generateMetaFiles ────────────────────────────────────────────────────────

/**
 * Recursively walks `contentDir` and writes a `_meta.js` file in every folder
 * that has content (markdown files, `.mdx` files, or non-empty subfolders).
 *
 * When `sidebarOverrides` is provided, directories with matching path keys
 * use the declared ordering/labels instead of alphabetical auto-generation.
 */
export async function generateMetaFiles(contentDir: string, sidebarOverrides?: SidebarOverrides): Promise<void> {
	await processDir(contentDir, contentDir, sidebarOverrides);
}

// ─── processDir (internal recursive helper) ───────────────────────────────────

async function processDir(dir: string, contentDir: string, sidebarOverrides?: SidebarOverrides): Promise<boolean> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return false;
	}

	const contentItems: string[] = [];

	for (const entry of entries) {
		if (entry.startsWith(".") || entry === "_meta.js") continue;

		const fullPath = join(dir, entry);

		let entryStat: Awaited<ReturnType<typeof stat>>;
		try {
			entryStat = await stat(fullPath);
		} catch {
			continue;
		}

		if (entryStat.isDirectory()) {
			const hasContent = await processDir(fullPath, contentDir, sidebarOverrides);
			if (hasContent) {
				contentItems.push(entry);
			}
		} else if (entryStat.isFile()) {
			const ext = extname(entry).toLowerCase();
			if (ext === ".md" || ext === ".mdx") {
				contentItems.push(entry);
			}
		}
	}

	if (contentItems.length === 0) {
		return false;
	}

	// Compute the path key for sidebar override lookup (e.g. "/", "/get-started")
	const relPath = relative(contentDir, dir);
	const pathKey = `/${relPath.split(sep).join("/")}`.replace(/\/$/, "") || "/";

	const override = sidebarOverrides?.[pathKey];
	const metaEntries = buildMetaEntries(contentItems, override);

	// Don't write _meta.js if all entries are hidden (e.g. folder with only index.md).
	// Nextra fails to prerender folders with _meta.js that has no visible entries.
	const hasVisibleEntries = metaEntries.some(
		(e) => typeof e.value === "string" || (typeof e.value === "object" && e.value.display !== "hidden"),
	);
	if (hasVisibleEntries) {
		await writeMetaFile(dir, metaEntries);
	}

	return true;
}

// ─── writeMetaFile (internal helper) ─────────────────────────────────────────

/**
 * Serialises `entries` into a Nextra v4 `_meta.js` ES-module and writes it
 * to `<dir>/_meta.js`.
 *
 * String values are written as simple strings. Object values are written as
 * JSON objects (for external links, hidden items, etc.).
 */
async function writeMetaFile(dir: string, entries: MetaEntry[]): Promise<void> {
	const lines = entries.map(({ key, value }) => {
		const serialized = typeof value === "string" ? `"${value}"` : JSON.stringify(value);
		return `  "${key}": ${serialized},`;
	});
	const content = `export default {\n${lines.join("\n")}\n}\n`;

	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "_meta.js"), content, "utf-8");
}
