/**
 * MetaGenerator — I/O half. Recursively walks a `content/` directory and
 * writes a `_meta.js` file in every folder with content (markdown / .mdx
 * files, or non-empty subfolders).
 *
 * The pure half — `buildMetaEntries`, `injectRootNavEntries`,
 * `serializeMetaEntries`, `hasVisibleEntries`, plus the types
 * (`RootApiSpec`, `RootInjectionInput`, `MetaEntry`) and constants
 * (`DOC_HOME_NAV_KEY`, `OPENAPI_NAV_KEY`) — lives in
 * `@jolli.ai/site-core`. This module reads directories + frontmatter,
 * routes entries through the pure helpers, and writes the resulting
 * `_meta.js` files to disk.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { RootInjectionInput, SidebarOverrides } from "@jolli.ai/site-core";
import { buildMetaEntries, hasVisibleEntries, injectRootNavEntries, serializeMetaEntries } from "@jolli.ai/site-core";
import { toForwardSlash } from "../core/PathUtils.js";

/**
 * Reads `index.mdx` / `index.md` if present in `contentItems` and reports
 * whether its frontmatter sets `asIndexPage: true`. Nextra v4 uses this flag
 * to promote the index to the folder's representative page; the folder's
 * `_meta.js` must omit the `"index"` key in that case.
 *
 * When both `index.mdx` and `index.md` are present, prefers `.mdx` to match
 * Nextra's own resolution order — otherwise the detector could disagree with
 * the file Nextra actually compiles and we'd emit the wrong `_meta.js` shape.
 *
 * The truthy match is anchored to column 0 (top-level YAML keys only) so a
 * nested key like `things:\n  asIndexPage: true` doesn't falsely register;
 * it also accepts the YAML 1.1 truthy variants Nextra's gray-matter parser
 * recognises (`true` / `True` / `TRUE` / `yes` / `Yes` / `YES`).
 */
async function detectAsIndexPage(dir: string, contentItems: string[]): Promise<boolean> {
	const indexFile = contentItems.includes("index.mdx")
		? "index.mdx"
		: contentItems.includes("index.md")
			? "index.md"
			: undefined;
	if (!indexFile) return false;
	let raw: string;
	try {
		raw = await readFile(join(dir, indexFile), "utf-8");
	} catch {
		return false;
	}
	const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fm) return false;
	return /^asIndexPage\s*:\s*(true|True|TRUE|yes|Yes|YES)\s*$/m.test(fm[1]);
}

// ─── generateMetaFiles ────────────────────────────────────────────────────────

/**
 * Recursively walks `contentDir` and writes a `_meta.js` file in every folder
 * that has content (markdown files, `.mdx` files, or non-empty subfolders).
 *
 * When `sidebarOverrides` is provided, directories with matching path keys
 * use the declared ordering/labels instead of alphabetical auto-generation.
 *
 * `rootInjection` only affects the root-level `_meta.js`. It auto-injects
 * `__documentation` + `__api-reference` entries from detected OpenAPI specs
 * and materialises `header.items` (from site.json) as native Nextra page
 * tabs — navbar styling, chevron, and mobile drawer integration come from
 * Nextra natively.
 */
export async function generateMetaFiles(
	contentDir: string,
	sidebarOverrides?: SidebarOverrides,
	rootInjection?: RootInjectionInput,
): Promise<void> {
	await processDir(contentDir, contentDir, sidebarOverrides, rootInjection);
}

// ─── processDir (internal recursive helper) ───────────────────────────────────

async function processDir(
	dir: string,
	contentDir: string,
	sidebarOverrides?: SidebarOverrides,
	rootInjection?: RootInjectionInput,
): Promise<boolean> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return false;
	}

	const contentItems: string[] = [];

	for (const entry of entries) {
		if (entry.startsWith(".") || entry === "_meta.js" || entry === "_meta.ts") continue;

		const fullPath = join(dir, entry);

		let entryStat: Awaited<ReturnType<typeof stat>>;
		try {
			entryStat = await stat(fullPath);
		} catch {
			continue;
		}

		if (entryStat.isDirectory()) {
			const hasContent = await processDir(fullPath, contentDir, sidebarOverrides, rootInjection);
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
	const pathKey = `/${toForwardSlash(relPath)}`.replace(/\/$/, "") || "/";

	const override = sidebarOverrides?.[pathKey];
	const indexHasAsIndexPage = await detectAsIndexPage(dir, contentItems);
	let metaEntries = buildMetaEntries(contentItems, override, { indexHasAsIndexPage });

	// Root-only augmentation: auto-inject `Documentation` / `API Reference`
	// page tabs and materialise `header.items` as Nextra-native tabs.
	if (pathKey === "/" && rootInjection) {
		metaEntries = injectRootNavEntries(metaEntries, rootInjection);
	}

	// Don't write _meta.js if all entries are hidden (e.g. folder with only index.md).
	// Nextra fails to prerender folders with _meta.js that has no visible entries.
	if (hasVisibleEntries(metaEntries)) {
		await writeMetaFile(dir, metaEntries);
	}

	return true;
}

// ─── writeMetaFile (internal helper) ─────────────────────────────────────────

/**
 * Writes a serialised `_meta.js` to `<dir>/_meta.js` and removes any
 * `_meta.ts` left behind by the OpenAPI pipeline. When MetaGenerator
 * also writes `_meta.js`, Nextra may load both and produce inconsistent
 * navigation, so the `.ts` variant is cleaned up here.
 */
async function writeMetaFile(dir: string, entries: ReturnType<typeof buildMetaEntries>): Promise<void> {
	const content = serializeMetaEntries(entries);

	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "_meta.js"), content, "utf-8");

	// Remove any _meta.ts in the same directory to prevent conflicts.
	const tsPath = join(dir, "_meta.ts");
	try {
		await rm(tsPath);
	} catch {
		// Not found — nothing to clean up
	}
}
