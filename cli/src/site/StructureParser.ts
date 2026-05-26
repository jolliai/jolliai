/**
 * NavigationParser — converts the `navigation` field in site.json into
 * the `SidebarOverrides` and `RootInjectionInput` that MetaGenerator
 * consumes.
 *
 * Two modes determined by the shape of `navigation`:
 *   - **Simple mode**: `(NavigationGroup | NavigationArticle)[]` →
 *     config-driven sidebar without pages
 *   - **Page mode**: `NavigationPage[]` → page-based navigation with
 *     a page switcher UI
 */

import type {
	Navigation,
	NavigationArticle,
	NavigationGroup,
	NavigationMenuItem,
	NavigationPage,
	SidebarItemValue,
	SidebarOverrides,
} from "./Types.js";

// ─── Type guards ────────────────────────────────────────────────────────────

function isGroup(node: NavigationGroup | NavigationArticle): node is NavigationGroup {
	return "group" in node;
}

function isPage(node: unknown): node is NavigationPage {
	return typeof node === "object" && node !== null && "page" in node;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Page metadata passed to the layout for rendering the page switcher. */
export interface PageInfo {
	key: string;
	title: string;
	href: string;
	type?: "menu";
	menuItems?: Record<string, { title: string; href: string }>;
}

export interface NavigationParseResult {
	sidebar: SidebarOverrides;
	/** Page list for the UI page switcher (only in page mode). */
	pages?: PageInfo[];
	/** Nextra root page entries (for sidebar scoping, only in page mode). */
	rootPages?: Array<{
		key: string;
		title: string;
		href: string;
		type?: "menu";
		menuItems?: Record<string, { title: string; href: string }>;
	}>;
	openapiPages?: Array<{ key: string; title: string; href: string; specPath: string; specName: string }>;
	/** First page's href — used for default page (only in page mode). */
	defaultPageHref?: string;
}

// ─── Limits (aligned with web tool SiteConfig.ts) ──────────────────────────

/** Maximum number of top-level pages in page mode. */
export const MAX_PAGES = 10;
/** Maximum nesting depth for article.articles children. */
export const MAX_ARTICLE_DEPTH = 4;

/**
 * Validates navigation limits and throws when exceeded. Called by
 * `parseNavigation` so both CLI and web tool enforce the same constraints.
 */
function validateNavigationLimits(navigation: Navigation): void {
	if (navigation.length === 0) return;

	if (isPage(navigation[0])) {
		const pages = navigation as NavigationPage[];
		if (pages.length > MAX_PAGES) {
			throw new Error(`Navigation has ${pages.length} pages but the maximum is ${MAX_PAGES}.`);
		}
		for (const page of pages) {
			if (page.content) {
				for (const node of page.content) {
					if (!("group" in node)) {
						validateArticleDepth(node, 1);
					} else {
						for (const article of node.content) {
							validateArticleDepth(article, 1);
						}
					}
				}
			}
		}
	} else {
		for (const node of navigation as (NavigationGroup | NavigationArticle)[]) {
			if ("group" in node) {
				for (const article of node.content) {
					validateArticleDepth(article, 1);
				}
			} else {
				validateArticleDepth(node, 1);
			}
		}
	}
}

function validateArticleDepth(article: NavigationArticle, depth: number): void {
	if (depth > MAX_ARTICLE_DEPTH) {
		throw new Error(`Article "${article.article}" exceeds maximum nesting depth of ${MAX_ARTICLE_DEPTH}.`);
	}
	if (article.articles) {
		for (const child of article.articles) {
			validateArticleDepth(child, depth + 1);
		}
	}
}

/**
 * Parses the `navigation` field from site.json into sidebar overrides
 * and optional page declarations. Handles both simple mode and page mode.
 */
export function parseNavigation(navigation: Navigation): NavigationParseResult {
	validateNavigationLimits(navigation);
	if (navigation.length === 0) {
		return { sidebar: {} };
	}

	if (!isPage(navigation[0])) {
		// Simple mode — array of groups/articles, no pages
		const sidebar: SidebarOverrides = {};
		parseContent(navigation as (NavigationGroup | NavigationArticle)[], "/", sidebar);
		return { sidebar };
	}

	// Page mode
	return parsePages(navigation as NavigationPage[]);
}

/**
 * Parses navigation pages into sidebar overrides + page metadata.
 */
export function parsePages(pages: NavigationPage[]): NavigationParseResult {
	const sidebar: SidebarOverrides = {};
	const pageInfos: PageInfo[] = [];
	const rootPages: NavigationParseResult["rootPages"] = [];
	const openapiPages: NavigationParseResult["openapiPages"] = [];

	for (const page of pages) {
		// Menu page — navbar dropdown, no content section
		if (page.type === "menu" && page.items) {
			const menuItems = menuItemsToMap(page.items);
			const key = slugify(page.page);
			pageInfos.push({ key, title: page.page, href: "#", type: "menu", menuItems });
			rootPages.push({ key, title: page.page, href: "#", type: "menu", menuItems });
			continue;
		}

		if (page.openapi) {
			const pageHref = normalizePageHref(page.root ?? `/api-${slugify(page.page)}`);
			const key = hrefToKey(pageHref);
			const specName = key.startsWith("api-") ? key.slice("api-".length) : key;
			openapiPages.push({ key, title: page.page, href: pageHref, specPath: page.openapi, specName });
			pageInfos.push({ key, title: page.page, href: pageHref });
			rootPages.push({ key, title: page.page, href: pageHref });
			continue;
		}

		const pageRoot = normalizePageHref(page.root ?? `/${slugify(page.page)}`);
		const key = hrefToKey(pageRoot);
		pageInfos.push({ key, title: page.page, href: pageRoot });
		rootPages.push({ key, title: page.page, href: pageRoot });

		if (page.content) {
			parseContent(page.content, pageRoot, sidebar);
		}
	}

	const defaultPageHref = pageInfos.length > 0 ? pageInfos[0].href : "/";
	return { sidebar, pages: pageInfos, rootPages, openapiPages, defaultPageHref };
}

// ─── Content parsing (groups + articles) ────────────────────────────────────

function parseContent(
	nodes: (NavigationGroup | NavigationArticle)[],
	pathPrefix: string,
	sidebar: SidebarOverrides,
): void {
	const entries: Record<string, SidebarItemValue> = {};

	for (const node of nodes) {
		if (isGroup(node)) {
			// A group is always rendered as a non-clickable separator at the
			// parent meta level. `node.root` is a source-location hint for
			// ContentPlanner — it does NOT contribute to the sidebar tree or
			// the URL path. The schema intent (group = separator) wins; the
			// generated build tree is flattened so articles inside the group
			// live at the parent level and Nextra renders them naturally.
			const groupSlug = slugify(node.group);
			entries[`__group-${groupSlug}`] = { type: "separator" as const, title: node.group };

			for (const article of node.content) {
				addArticle(article, pathPrefix, entries, sidebar);
			}
		} else {
			addArticle(node, pathPrefix, entries, sidebar);
		}
	}

	if (Object.keys(entries).length > 0) {
		sidebar[pathPrefix] = entries;
	}
}

// ─── Article processing ─────────────────────────────────────────────────────

function addArticle(
	article: NavigationArticle,
	resolveRoot: string,
	entries: Record<string, SidebarItemValue>,
	sidebar: SidebarOverrides,
): void {
	if (article.type === "external") {
		entries[slugify(article.article)] = {
			title: article.article,
			href: article.href,
		};
		return;
	}

	const hrefSegments = article.href.split("/").filter(Boolean);
	// When the article has nested children and `expanded` is set explicitly,
	// emit the _meta.js entry as an object with `theme.collapsed` so Nextra
	// honors the customer's open/closed intent regardless of
	// `defaultMenuCollapseLevel`. When `expanded` is omitted, fall through to
	// the plain string entry so Nextra's per-depth default applies.
	const entryValue: SidebarItemValue =
		article.articles?.length && article.expanded !== undefined
			? { title: article.article, theme: { collapsed: !article.expanded } }
			: article.article;

	if (hrefSegments.length === 1) {
		// Single segment — goes directly into the current entries
		entries[hrefSegments[0]] = entryValue;
	} else {
		// Multi-segment href (e.g. "real-time-apps/part1") — the first segment
		// is a directory reference in the current _meta.js, and the last segment
		// goes into that directory's _meta.js.
		entries[hrefSegments[0]] = entries[hrefSegments[0]] ?? hrefSegments[0];
		let intermediatePath = joinPath(resolveRoot, hrefSegments[0]);
		for (let i = 1; i < hrefSegments.length; i++) {
			const seg = hrefSegments[i];
			const isLast = i === hrefSegments.length - 1;
			if (!sidebar[intermediatePath]) {
				sidebar[intermediatePath] = {};
			}
			(sidebar[intermediatePath] as Record<string, SidebarItemValue>)[seg] = isLast
				? entryValue
				: ((sidebar[intermediatePath] as Record<string, SidebarItemValue>)[seg] ?? seg);
			if (!isLast) {
				intermediatePath = joinPath(intermediatePath, seg);
			}
		}
	}

	// Nested articles write into the parent article's directory _meta.js.
	// Single-segment children go into subEntries (merged into parent dir).
	// Multi-segment children write directly to sidebar via the multi-segment
	// logic above, so they bypass subEntries.
	if (article.articles?.length) {
		const parentDir = article.href.startsWith("/")
			? article.href
			: joinPath(resolveRoot, hrefSegments.length === 1 ? hrefSegments[0] : hrefSegments.slice(0, -1).join("/"));
		for (const child of article.articles) {
			const childSegments = child.href.split("/").filter(Boolean);
			if (childSegments.length === 1) {
				// Single-segment child → goes into the parent's directory _meta.js
				if (!sidebar[parentDir]) {
					sidebar[parentDir] = {};
				}
				(sidebar[parentDir] as Record<string, SidebarItemValue>)[childSegments[0]] = child.article;
				// Recurse for children of children
				if (child.articles?.length) {
					for (const grandchild of child.articles) {
						addArticle(grandchild, resolveRoot, {} as Record<string, SidebarItemValue>, sidebar);
					}
				}
			} else {
				// Multi-segment child → writes directly to sidebar via addArticle
				addArticle(child, resolveRoot, entries, sidebar);
			}
		}
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function normalizePageHref(href: string): string {
	if (href === "/") {
		return href;
	}
	const withLeadingSlash = href.startsWith("/") ? href : `/${href}`;
	return withLeadingSlash.replace(/\/+$/, "");
}

function hrefToKey(href: string): string {
	const segments = href.split("/").filter(Boolean);
	return segments.length > 0 ? segments[segments.length - 1] : href;
}

function joinPath(base: string, segment: string): string {
	const b = base.endsWith("/") ? base.slice(0, -1) : base;
	const s = segment.startsWith("/") ? segment : `/${segment}`;
	return b + s;
}

function menuItemsToMap(items: NavigationMenuItem[]): Record<string, { title: string; href: string }> {
	const map: Record<string, { title: string; href: string }> = {};
	for (const item of items) {
		map[slugify(item.label)] = { title: item.label, href: item.url };
	}
	return map;
}
