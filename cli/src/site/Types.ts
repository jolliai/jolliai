/**
 * Jolli Site Type Definitions
 *
 * Shared type definitions for the `jolli new` and `jolli start` site modules.
 */

/** File classification used by ContentMirror to categorize source files */
export type FileType = "markdown" | "openapi" | "image" | "ignored";

/** A navigation bar link entry in site.json (legacy flat shorthand for `header.items`). */
export interface NavLink {
	label: string;
	href: string;
}

/**
 * A simple labelled URL — used as a footer-column link, a header-dropdown
 * sub-item, etc. Matches the SaaS `ExternalLink` shape (minus the editor-only
 * `id` field, which the CLI doesn't need).
 */
export interface ExternalLink {
	label: string;
	url: string;
}

/**
 * Header navbar item — direct link (`url`) OR dropdown (`items`),
 * mutually exclusive. Matches the SaaS `HeaderNavItem` shape.
 */
export interface HeaderItem {
	label: string;
	url?: string;
	items?: ExternalLink[];
}

/** Header navigation config in site.json. */
export interface HeaderConfig {
	items: HeaderItem[];
}

/** A footer column with a heading and a list of links. */
export interface FooterColumn {
	title: string;
	links: ExternalLink[];
}

/** Social-icon URLs rendered alongside footer columns. */
export interface SocialLinks {
	github?: string;
	twitter?: string;
	discord?: string;
	linkedin?: string;
	youtube?: string;
}

/** Footer config in site.json. */
export interface FooterConfig {
	copyright?: string;
	columns?: FooterColumn[];
	socialLinks?: SocialLinks;
}

/**
 * A sidebar entry value in site.json:
 *   - `string` → custom label (e.g. `"Install Feldera"`)
 *   - `object` → Nextra _meta.js object (e.g. external link, hidden item)
 */
export type SidebarItemValue =
	| string
	| {
			title?: string;
			href?: string;
			type?: "separator";
	  };

/**
 * Sidebar overrides keyed by directory path (e.g. `"/"`, `"/get-started"`).
 * Each value is an ordered map of `{ key: SidebarItemValue }`.
 * Items are written to `_meta.js` in declaration order; Nextra auto-appends
 * unlisted filesystem items alphabetically.
 */
export type SidebarOverrides = Record<string, Record<string, SidebarItemValue>>;

/**
 * Maps source folder paths to target folder paths when the sidebar's
 * logical structure differs from the physical folder structure.
 * e.g. `{ "sql": "pipelines/sql" }` means `sql/` in source → `pipelines/sql/` in content.
 */
export type PathMappings = Record<string, string>;

/** The parsed contents of site.json */
export interface SiteJson {
	title: string;
	description: string;
	/**
	 * Flat navbar shorthand. When `header` is also present, `header.items`
	 * wins; otherwise these entries are coerced into header dropdown-less
	 * items at render time so existing CLI sites keep working unchanged.
	 */
	nav: NavLink[];
	/**
	 * Header navbar — supports per-item dropdowns. Mirrors the SaaS
	 * `HeaderLinksConfig` shape so a single `site.json` works in both systems.
	 */
	header?: HeaderConfig;
	/**
	 * Site footer — copyright, columns of links, and social-icon URLs.
	 * Mirrors the SaaS `FooterConfig` shape.
	 */
	footer?: FooterConfig;
	sidebar?: SidebarOverrides;
	pathMappings?: PathMappings;
	favicon?: string;
	renderer?: string;
	[key: string]: unknown; // unknown fields are silently ignored
}

/** Returned by StarterKit.scaffoldProject */
export interface ScaffoldResult {
	success: boolean;
	targetDir: string;
	message?: string;
}

/** Returned by ContentMirror.mirrorContent */
export interface MirrorResult {
	/** Relative paths of mirrored markdown files */
	markdownFiles: string[];
	/** Relative paths of mirrored OpenAPI files */
	openapiFiles: string[];
	/** Relative paths of mirrored image files */
	imageFiles: string[];
	/** Relative paths of files that were skipped */
	ignoredFiles: string[];
	/** Number of .mdx files downgraded to .md due to incompatible content */
	downgradedCount: number;
	/** If a file with `slug: /` was renamed to index.md, this is the old key (e.g. "what-is-feldera") */
	renamedToIndex?: string;
}

/** Returned by NpmRunner functions */
export interface NpmRunResult {
	success: boolean;
	output: string;
}

/** Returned by PagefindRunner.runPagefind */
export interface PagefindResult {
	success: boolean;
	pagesIndexed?: number;
	output: string;
}
