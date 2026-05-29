/**
 * MetaGenerator (pure half).
 *
 * Computes `_meta.js` entry lists for a folder's children — applies
 * sidebar overrides in declaration order or falls back to alphabetical
 * filesystem ordering with title-cased labels. Auto-injects the root
 * `__documentation` / `__api-reference` tabs and materializes
 * `header.items` from site.json into native Nextra page-tab entries.
 *
 * All inputs are passed in by value (a `string[]` of filenames, the
 * optional sidebar override, the root-injection input). This module
 * never reads or writes the filesystem.
 *
 * The I/O half — walking the content directory, detecting which folders
 * have an `asIndexPage: true` index, and writing the actual `_meta.js`
 * files — lives in `cli/src/site/MetaGenerator.ts` and consumes the
 * entry lists produced here.
 */

import type { HeaderItem, SidebarItemValue } from "./Types.js";

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
	 * `site.json`'s `header.items`. Used **only** for override detection —
	 * a customer-declared "Documentation" / "API Reference" label suppresses
	 * the matching auto-injection. Items are **not** materialised into
	 * `_meta.js`; themes render header items inline in their own `<Navbar>`
	 * JSX, and emitting them here as well would surface every link twice
	 * (theme row + Nextra's auto page-tabs strip).
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

function stripFileExtension(filename: string): { key: string; ext: string } {
	const lastDot = filename.lastIndexOf(".");
	if (lastDot < 0) return { key: filename, ext: "" };
	return { key: filename.slice(0, lastDot), ext: filename.slice(lastDot) };
}

/**
 * Default behavior: all items alphabetically sorted with auto-generated labels.
 */
function buildDefaultEntries(filenames: string[], options?: { indexHasAsIndexPage?: boolean }): MetaEntry[] {
	const seen = new Set<string>();
	const entries: MetaEntry[] = [];

	for (const filename of filenames) {
		const { key, ext } = stripFileExtension(filename);
		const finalKey = ext ? key : filename;

		// Hide index files from sidebar — they serve as the folder's own page.
		// Using display: "hidden" prevents Nextra from auto-appending them
		// as visible children while still allowing them to be the folder page.
		// When the index has `asIndexPage: true` in its frontmatter, Nextra
		// promotes it to the folder's representative page and removes it from
		// children entirely — emitting an `"index"` _meta entry in that case
		// produces "field key 'index' refers to a page that cannot be found"
		// at build time, so we skip it.
		if (finalKey === "index") {
			if (!options?.indexHasAsIndexPage) {
				entries.push({ key: finalKey, value: { display: "hidden" } });
			}
			seen.add(finalKey);
			continue;
		}

		if (seen.has(finalKey)) continue;
		seen.add(finalKey);

		entries.push({ key: finalKey, value: toTitleCase(finalKey) });
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
		const { key, ext } = stripFileExtension(f);
		const finalKey = ext ? key : f;
		return finalKey === "index";
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
 * Returns a new entry list with auto-injected `Documentation` / `API Reference`
 * tabs:
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
 *
 * Customer `header.items` are **not** materialised into `_meta.js` — each
 * theme renders them inline in its own `<Navbar>` JSX. If both surfaces
 * emitted them, every header link would appear twice (once in the theme
 * navbar row, once in Nextra's auto page-links strip). Themes own header
 * presentation end-to-end; `injectRootNavEntries` only consults
 * `header.items` here for override detection (a customer-declared
 * "Documentation" suppresses `__documentation`, etc.).
 *
 * Order matters: Nextra renders root tabs in `_meta.js` declaration order,
 * and we want `Documentation` first (primary anchor), `API Reference` next.
 */
export function injectRootNavEntries(existing: MetaEntry[], input: RootInjectionInput): MetaEntry[] {
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

	// Navigation pages — `type: "page"` for Nextra sidebar scoping, or
	// `type: "menu"` for navbar dropdown pages.
	// Nextra renders these as navbar links; pack CSS repositions them
	// as a second-row tab bar with active underline via aria-current.
	if (input.structurePages) {
		const usedKeys = new Set<string>();
		for (const sp of input.structurePages) {
			if (usedKeys.has(sp.key)) continue;
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
			usedKeys.add(sp.key);
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

	// Non-structure injected entries (API specs, auto-Documentation) should
	// not duplicate existing keys.
	const existingKeys = new Set(filteredExisting.map((e) => e.key));
	const filtered = injected.filter((e) => structureKeys.has(e.key) || !existingKeys.has(e.key));
	return [...filtered, ...filteredExisting];
}

// ─── serializeMetaEntries ────────────────────────────────────────────────────

/**
 * Serialises `entries` into the body of a Nextra v4 `_meta.js` ES module.
 *
 * Both keys and values flow through `JSON.stringify` so a customer-supplied
 * sidebar override label or key containing `"`, `\`, or other JS-string-
 * significant characters cannot produce an unparseable `_meta.js` (which
 * would crash the customer's `next build` pointing at a file they don't own).
 *
 * Returns the full file content as a UTF-8 string; the caller writes it to
 * disk wherever appropriate.
 */
export function serializeMetaEntries(entries: MetaEntry[]): string {
	const lines = entries.map(({ key, value }) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
	return `export default {\n${lines.join("\n")}\n}\n`;
}

/**
 * Returns `true` when at least one entry in `entries` is visible in the
 * sidebar (i.e. not `display: "hidden"`). Folders with no visible entries
 * should not get a `_meta.js` written — Nextra fails to prerender them.
 */
export function hasVisibleEntries(entries: MetaEntry[]): boolean {
	return entries.some(
		(e) => typeof e.value === "string" || (typeof e.value === "object" && e.value.display !== "hidden"),
	);
}
