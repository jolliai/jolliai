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
import { sanitizeUrl } from "./Sanitize.js";
import type { HeaderItem, SidebarItemValue, SidebarOverrides } from "./Types.js";

// ─── Root-injection types ────────────────────────────────────────────────────

/**
 * One detected OpenAPI spec used by `injectRootNavEntries` to decide
 * single-spec vs multi-spec navbar shape.
 */
export interface RootApiSpec {
	/** URL slug (matches `/api-{specName}` route + `content/api-{specName}/` folder). */
	specName: string;
	/** Display title from `info.title`. Falls back to the slug when unset. */
	title?: string;
}

/**
 * Optional inputs for root `_meta.js` augmentation. None of these affect
 * non-root meta files.
 */
export interface RootInjectionInput {
	/** Detected OpenAPI specs — drives the auto-injected `Documentation` + `API Reference` entries. */
	apiSpecs?: RootApiSpec[];
	/**
	 * `site.json`'s `header.items`. Each entry is materialised as a root
	 * `_meta.js` key so Nextra renders it as a native page-tab (with chevron
	 * for `items`-bearing dropdowns) instead of custom JSX.
	 */
	headerItems?: HeaderItem[];
}

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
 *
 * `rootInjection` only affects the root-level `_meta.js`. It auto-injects
 * `__documentation` + `__api-reference` entries from detected OpenAPI specs
 * and materialises `header.items` (from site.json) as native Nextra page
 * tabs. Mirrors the SaaS `injectOpenApiNavEntries` so navbar styling, chevron,
 * mobile drawer integration come from Nextra natively.
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
		if (entry.startsWith(".") || entry === "_meta.js") continue;

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
	const pathKey = `/${relPath.split(sep).join("/")}`.replace(/\/$/, "") || "/";

	const override = sidebarOverrides?.[pathKey];
	let metaEntries = buildMetaEntries(contentItems, override);

	// Root-only augmentation: auto-inject `Documentation` / `API Reference`
	// page tabs and materialise `header.items` as Nextra-native tabs.
	if (pathKey === "/" && rootInjection) {
		metaEntries = injectRootNavEntries(metaEntries, rootInjection);
	}

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

// ─── injectRootNavEntries ────────────────────────────────────────────────────

/**
 * Reserved keys for the auto-injected root navbar entries. Exported so tests
 * (and future inspector tooling) can assert against the same string the SaaS
 * uses, keeping the two surfaces aligned.
 */
export const DOC_HOME_NAV_KEY = "__documentation";
export const OPENAPI_NAV_KEY = "__api-reference";

/** Customer-side labels that suppress auto-injection (case-insensitive). */
const DOCUMENTATION_LABELS = new Set(["documentation"]);
const API_REFERENCE_LABELS = new Set(["api reference", "api"]);

/**
 * Slugifies a header-item label into a stable `_meta.js` key. Uses a
 * `nav-` prefix to namespace customer-supplied entries so they cannot
 * collide with auto-injected `__documentation` / `__api-reference` /
 * `api-{slug}` keys, even via crafted labels.
 *
 * Falls back to `nav-${idx}` when slugification yields an empty string —
 * e.g. a label that was all punctuation.
 */
function navKeyFromLabel(label: string, idx: number): string {
	const slug = label
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug ? `nav-${slug}` : `nav-${idx}`;
}

/**
 * Returns a new entry list with auto-injected `Documentation` / `API Reference`
 * tabs and materialised `header.items` entries. Mirrors the SaaS
 * `injectOpenApiNavEntries`:
 *
 *   - `__documentation` page-tab linking to `/` whenever the customer has any
 *     specs and hasn't already declared a header item labelled "Documentation".
 *   - **Single spec, no override**: the spec's `api-{slug}` entry doubles as
 *     the visible "API Reference" navbar tab — `{ title: "API Reference",
 *     type: "page", href: "/api-{slug}" }`. The href makes it a link in docs
 *     scope; `<ScopedNextraLayout>` strips the href when inside the spec's
 *     folder so Nextra binds it for sidebar scoping.
 *   - **Multi-spec (or single spec with a user "API Reference" override)**:
 *     each spec is recorded as a hidden page-tab + a visible
 *     `__api-reference` dropdown (`type: "menu"`) whose `items` map is one
 *     sub-entry per spec.
 *   - User-supplied `header.items` are appended after the auto entries with
 *     `nav-{slug}` keys derived from the label so customer reordering is a
 *     no-op on the generated keys. URLs flow through `sanitizeUrl` —
 *     `javascript:` / `data:` URLs are clamped to `"#"`.
 *     A header item with a clashing label (Documentation / API / API
 *     Reference, case-insensitive) suppresses the matching auto injection —
 *     customer overrides win.
 *
 * Order matters: Nextra renders root tabs in `_meta.js` declaration order,
 * and we want `Documentation` first (primary anchor), `API Reference` next,
 * then user-supplied tabs.
 */
function injectRootNavEntries(existing: MetaEntry[], input: RootInjectionInput): MetaEntry[] {
	const apiSpecs = input.apiSpecs ?? [];
	const headerItems = input.headerItems ?? [];

	const userLabels = new Set<string>();
	for (const item of headerItems) {
		userLabels.add(item.label.trim().toLowerCase());
	}
	const skipDocumentation = [...DOCUMENTATION_LABELS].some((label) => userLabels.has(label));
	const skipApiReference = [...API_REFERENCE_LABELS].some((label) => userLabels.has(label));

	const injected: MetaEntry[] = [];

	if (apiSpecs.length > 0 && !skipDocumentation) {
		injected.push({
			key: DOC_HOME_NAV_KEY,
			value: { title: "Documentation", type: "page", href: "/" },
		});
	}

	if (apiSpecs.length === 1 && !skipApiReference) {
		// Single-spec form — the per-spec entry IS the visible navbar API
		// Reference link. Carries an `href` so it acts as a navigation link
		// in docs scope; `<ScopedNextraLayout>` strips the href when inside
		// the spec's folder so Nextra binds it for sidebar scoping.
		const spec = apiSpecs[0];
		injected.push({
			key: `api-${spec.specName}`,
			value: { title: "API Reference", type: "page", href: `/api-${spec.specName}` },
		});
	} else if (apiSpecs.length > 1) {
		// Multi-spec — per-spec entries are hidden by default, the visible
		// dropdown at `OPENAPI_NAV_KEY` handles navigation. Each spec entry
		// is kept so `<ScopedNextraLayout>` can un-hide the active one for
		// sidebar binding.
		for (const spec of apiSpecs) {
			injected.push({
				key: `api-${spec.specName}`,
				value: { title: spec.title?.trim() || spec.specName, type: "page", display: "hidden" },
			});
		}
		if (!skipApiReference) {
			const items: Record<string, { title: string; href: string }> = {};
			for (const spec of apiSpecs) {
				items[spec.specName] = {
					title: spec.title?.trim() || spec.specName,
					href: `/api-${spec.specName}`,
				};
			}
			injected.push({
				key: OPENAPI_NAV_KEY,
				value: { title: "API Reference", type: "menu", items },
			});
		}
	}

	// User-supplied header items — coerced into Nextra page-tab shape with
	// sanitised URLs and slug-derived keys (stable across reordering).
	const usedNavKeys = new Set<string>();
	headerItems.forEach((item, idx) => {
		let key = navKeyFromLabel(item.label, idx);
		// Defuse two `header.items` entries with the same label collapsing onto
		// one key (Nextra reads the last definition wins; we'd rather keep all
		// entries by appending an index suffix on collision).
		if (usedNavKeys.has(key)) {
			key = `${key}-${idx}`;
		}
		usedNavKeys.add(key);

		if (item.items && item.items.length > 0) {
			const items: Record<string, { title: string; href: string }> = {};
			const usedSubKeys = new Set<string>();
			item.items.forEach((sub, subIdx) => {
				// `navKeyFromLabel` always returns `nav-{slug}` or `nav-{idx}`, so
				// after stripping the prefix we always have at least one character.
				let subKey = navKeyFromLabel(sub.label, subIdx).replace(/^nav-/, "");
				// Same dedup discipline as the outer header-items loop: two sub-items
				// with the same label otherwise collapse to one entry (last wins).
				if (usedSubKeys.has(subKey)) {
					subKey = `${subKey}-${subIdx}`;
				}
				usedSubKeys.add(subKey);
				items[subKey] = { title: sub.label, href: sanitizeUrl(sub.url) };
			});
			injected.push({ key, value: { title: item.label, type: "menu", items } });
		} else {
			const value: Record<string, unknown> = { title: item.label, type: "page" };
			if (item.url) {
				value.href = sanitizeUrl(item.url);
			}
			injected.push({ key, value });
		}
	});

	if (injected.length === 0) {
		return existing;
	}

	// De-duplicate against keys the existing entry list already declares
	// (e.g. when the customer wrote a manual `_meta.js` override that
	// already pins `__documentation`).
	const existingKeys = new Set(existing.map((e) => e.key));
	const filtered = injected.filter((e) => !existingKeys.has(e.key));
	return [...filtered, ...existing];
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
