/**
 * Jolli Site Type Definitions
 *
 * Shared type definitions for the `jolli new` and `jolli start` site modules.
 */

/** File classification used by ContentMirror to categorize source files */
export type FileType = "markdown" | "openapi" | "image" | "ignored";

/** A navigation bar link entry in site.json */
export interface NavLink {
	label: string;
	href: string;
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
	nav: NavLink[];
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
