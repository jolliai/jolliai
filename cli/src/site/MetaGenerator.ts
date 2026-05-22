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

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
	/**
	 * Pages declared via `navigation` field. Each becomes a Nextra
	 * `type: "page"` entry (or `type: "menu"` for menu pages) in the
	 * root `_meta.js`.
	 */
	structurePages?: Array<{
		key: string;
		title: string;
		href: string;
		type?: "menu";
		menuItems?: Record<string, { title: string; href: string }>;
	}>;
	/**
	 * When navigation pages are used, the root `index` entry should redirect
	 * to this href so the first page is the default landing page.
	 */
	defaultPageHref?: string;
	/**
	 * When `true`, the navigation uses simple mode (groups/articles only, no
	 * pages). Auto-injection of `type: "page"` entries (Documentation, API
	 * Reference) is suppressed — those entries break Nextra validation in
	 * simple mode because there's no page-level scoping.
	 */
	simpleMode?: boolean;
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
export function buildMetaEntries(
	filenames: string[],
	override?: Record<string, SidebarItemValue>,
	options?: { indexHasAsIndexPage?: boolean },
): MetaEntry[] {
	if (override) {
		return buildOverriddenEntries(filenames, override, options);
	}
	return buildDefaultEntries(filenames, options);
}

/**
 * Default behavior: all items alphabetically sorted with auto-generated labels.
 */
function buildDefaultEntries(filenames: string[], options?: { indexHasAsIndexPage?: boolean }): MetaEntry[] {
	const seen = new Set<string>();
	const entries: MetaEntry[] = [];

	for (const filename of filenames) {
		const ext = extname(filename);
		const key = ext ? basename(filename, ext) : filename;

		// Hide index files from sidebar — they serve as the folder's own page.
		// Using display: "hidden" prevents Nextra from auto-appending them
		// as visible children while still allowing them to be the folder page.
		// When the index has `asIndexPage: true` in its frontmatter, Nextra
		// promotes it to the folder's representative page and removes it from
		// children entirely — emitting an `"index"` _meta entry in that case
		// produces "field key 'index' refers to a page that cannot be found"
		// at build time, so we skip it.
		if (key === "index") {
			if (!options?.indexHasAsIndexPage) {
				entries.push({ key, value: { display: "hidden" } });
			}
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
function buildOverriddenEntries(
	filenames: string[],
	override: Record<string, SidebarItemValue>,
	options?: { indexHasAsIndexPage?: boolean },
): MetaEntry[] {
	const entries: MetaEntry[] = [];

	// If the folder has an index file but the override doesn't mention it,
	// add it as hidden to prevent Nextra from showing it as a duplicate child.
	// When the index has `asIndexPage: true`, skip — see the matching comment
	// in `buildDefaultEntries` for why.
	const hasIndexFile = filenames.some((f) => {
		const ext = extname(f);
		const key = ext ? basename(f, ext) : f;
		return key === "index";
	});
	if (hasIndexFile && !override.index && !options?.indexHasAsIndexPage) {
		entries.push({ key: "index", value: { display: "hidden" } });
	}

	// Declared items in declaration order
	for (const [key, value] of Object.entries(override)) {
		if (typeof value === "string") {
			entries.push({ key, value });
		} else {
			const obj = { ...value } as Record<string, unknown>;
			// Compose icon into title for Nextra (no native icon support)
			if (typeof obj.icon === "string" && obj.icon) {
				const title = typeof obj.title === "string" ? obj.title : key;
				obj.title = `${obj.icon} ${title}`;
				delete obj.icon;
			}
			entries.push({ key, value: obj });
		}
	}

	return entries;
}

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
	const pathKey = `/${relPath.split(sep).join("/")}`.replace(/\/$/, "") || "/";

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
 * (and future inspector tooling) can assert against the canonical string.
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
 * tabs and materialised `header.items` entries:
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
 * then user-supplied pages.
 */
function injectRootNavEntries(existing: MetaEntry[], input: RootInjectionInput): MetaEntry[] {
	const apiSpecs = input.apiSpecs ?? [];
	// `HeaderItem.label: string` is required at the type level, but site.json
	// is parsed without shape validation, so a customer who writes
	// `{ url: "/foo" }` (label omitted) reaches us with `label === undefined`.
	// Skip malformed entries with a console warning instead of crashing the
	// build pipeline with `TypeError: Cannot read properties of undefined`.
	const headerItems = (input.headerItems ?? []).filter((item) => {
		if (typeof item?.label !== "string" || item.label.trim() === "") {
			console.warn(`[jolli] Skipping header.items entry with missing or empty 'label': ${JSON.stringify(item)}`);
			return false;
		}
		return true;
	});

	const userLabels = new Set<string>();
	for (const item of headerItems) {
		userLabels.add(item.label.trim().toLowerCase());
	}
	// Navigation pages also count as user-supplied labels so auto-injection
	// doesn't duplicate entries the user already defined.
	for (const sp of input.structurePages ?? []) {
		userLabels.add(sp.title.trim().toLowerCase());
	}
	const skipDocumentation = [...DOCUMENTATION_LABELS].some((label) => userLabels.has(label));
	const skipApiReference = [...API_REFERENCE_LABELS].some((label) => userLabels.has(label));

	const injected: MetaEntry[] = [];

	// In simple mode (no pages), skip auto-injection of type:"page" entries —
	// they break Nextra validation when there's no page-level scoping.
	if (input.simpleMode) {
		return existing;
	}

	// When the user has explicit navigation pages (structurePages), they've
	// defined their own page structure — don't auto-inject "Documentation".
	const hasExplicitPages = (input.structurePages ?? []).length > 0;

	if (apiSpecs.length > 0 && !skipDocumentation && !hasExplicitPages) {
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
			const items: Record<string, { title: string; href?: string }> = {};
			const usedSubKeys = new Set<string>();
			// Same defensive filter as the outer loop — `ExternalLink.label: string`
			// is required at the type level but site.json shape isn't validated.
			const validSubItems = item.items.filter((sub) => {
				if (typeof sub?.label !== "string" || sub.label.trim() === "") {
					console.warn(
						`[jolli] Skipping header.items[].items entry with missing/empty 'label': ${JSON.stringify(sub)}`,
					);
					return false;
				}
				return true;
			});
			validSubItems.forEach((sub, subIdx) => {
				// `navKeyFromLabel` always returns `nav-{slug}` or `nav-{idx}`, so
				// after stripping the prefix we always have at least one character.
				let subKey = navKeyFromLabel(sub.label, subIdx).replace(/^nav-/, "");
				// Same dedup discipline as the outer header-items loop: two sub-items
				// with the same label otherwise collapse to one entry (last wins).
				if (usedSubKeys.has(subKey)) {
					subKey = `${subKey}-${subIdx}`;
				}
				usedSubKeys.add(subKey);
				// Mirror the outer-item url-defensive pattern: `ExternalLink.url` is
				// required at the type level but site.json shape isn't validated, so a
				// sub-item with a missing `url` would otherwise crash `sanitizeUrl`'s
				// `url.trim()` call. Emit the entry without href when url is missing
				// so the build doesn't blow up on a malformed config.
				const subValue: { title: string; href?: string } = { title: sub.label };
				if (sub.url) {
					subValue.href = sanitizeUrl(sub.url);
				}
				items[subKey] = subValue;
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

	// Navigation pages — `type: "page"` for Nextra sidebar scoping, or
	// `type: "menu"` for navbar dropdown pages.
	// Nextra renders these as navbar links; pack CSS repositions them
	// as a second-row tab bar with active underline via aria-current.
	if (input.structurePages) {
		for (const sp of input.structurePages) {
			if (!usedNavKeys.has(sp.key)) {
				if (sp.type === "menu" && sp.menuItems) {
					injected.push({
						key: sp.key,
						value: { title: sp.title, type: "menu", items: sp.menuItems },
					});
				} else {
					injected.push({
						key: sp.key,
						value: { title: sp.title, type: "page", href: sp.href },
					});
				}
				usedNavKeys.add(sp.key);
			}
		}
	}

	if (injected.length === 0) {
		return existing;
	}

	// Structure pages must replace filesystem-discovered entries with the
	// same key (e.g. a folder "documentation" becomes `type: "page"` tab).
	const structureKeys = new Set((input.structurePages ?? []).map((p) => p.key));
	// When a structure page's href points to a different folder (e.g. key
	// "api-reference" → href "/api-openapi"), suppress the filesystem-
	// discovered entry so it doesn't appear as a duplicate nav item.
	// scopePageMap's collectLinkFormApiKeys resolves href targets from
	// non-api data entries, so the folder is still kept client-side.
	const structureHrefTargets = new Set(
		(input.structurePages ?? []).map((p) => p.href.replace(/^\//, "")).filter((h) => h.length > 0),
	);
	const filteredExisting = existing.filter((e) => {
		if (structureKeys.has(e.key)) return false;
		if (structureHrefTargets.has(e.key)) return false;
		return true;
	});

	// Non-structure injected entries (API specs, header items) should not
	// duplicate existing keys.
	const existingKeys = new Set(filteredExisting.map((e) => e.key));
	const filtered = injected.filter((e) => structureKeys.has(e.key) || !existingKeys.has(e.key));
	return [...filtered, ...filteredExisting];
}

// ─── writeMetaFile (internal helper) ─────────────────────────────────────────

/**
 * Serialises `entries` into a Nextra v4 `_meta.js` ES-module and writes it
 * to `<dir>/_meta.js`.
 *
 * Both keys and values flow through `JSON.stringify` so a customer-supplied
 * sidebar override label or key containing `"`, `\`, or other JS-string-
 * significant characters cannot produce an unparseable `_meta.js` (which
 * would crash the customer's `next build` pointing at a file they don't own).
 * Object values were already going through `JSON.stringify`; this consolidates
 * the string-value branch onto the same path.
 */
async function writeMetaFile(dir: string, entries: MetaEntry[]): Promise<void> {
	const lines = entries.map(({ key, value }) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
	const content = `export default {\n${lines.join("\n")}\n}\n`;

	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "_meta.js"), content, "utf-8");

	// Remove any _meta.ts in the same directory to prevent conflicts.
	// The OpenAPI pipeline writes _meta.ts for endpoint ordering; when
	// MetaGenerator also writes _meta.js, Nextra may load both and
	// produce inconsistent navigation.
	const tsPath = join(dir, "_meta.ts");
	try {
		await rm(tsPath);
	} catch {
		// Not found — nothing to clean up
	}
}
