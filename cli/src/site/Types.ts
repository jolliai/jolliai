/**
 * Jolli Site Type Definitions
 *
 * Shared type definitions for the `jolli new` and `jolli start` site modules.
 */

import type { OpenApiDocument } from "./openapi/Types.js";

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

/**
 * Visual theme pack — picks the layout/CSS shell.
 *   - `default` — vanilla `nextra-theme-docs` (current behaviour, shipped before
 *     theme packs existed). The fallback when `theme.pack` is unset.
 *   - `forge` — clean developer-docs pack: light default, sidebar-first layout,
 *     Inter typography, hairline borders. Mirrors the SaaS Forge pack post-1392.
 *   - `atlas` — editorial pack: dark default, top-nav, serif headlines,
 *     airy spacing, masthead footer. Mirrors the SaaS Atlas pack.
 */
export type ThemePack = "default" | "forge" | "atlas";

/** Initial colour scheme for visitors. */
export type DefaultThemeMode = "light" | "dark" | "system";

/**
 * Font families a pack can resolve via Google Fonts. Names match the SaaS
 * `FontFamily` enum so a single site.json works in both surfaces.
 */
export type FontFamily = "inter" | "space-grotesk" | "ibm-plex" | "source-sans" | "source-serif";

/**
 * Visual theme block in site.json. Mirrors the customer-facing surface of
 * the SaaS `SiteBranding` (post-1392), minus tenant-only fields (`siteName` —
 * the CLI uses `title` at the top level instead, `customCss`, `legacyBranding`).
 *
 * All fields are optional; each pack's manifest supplies defaults (e.g. Forge
 * defaults to `primaryHue: 228`, `defaultTheme: "light"`, `fontFamily: "inter"`).
 */
export interface ThemeConfig {
	pack?: ThemePack;
	/** Image URL for logo (light mode and fallback when `logoUrlDark` is unset). */
	logoUrl?: string;
	/** Optional dark-mode logo variant. The pack swaps when `.dark` is active. */
	logoUrlDark?: string;
	/**
	 * Favicon URL. When the legacy top-level `favicon` field is also set, the
	 * top-level value wins (deprecated alias kept for back-compat).
	 */
	favicon?: string;
	/** Primary accent hue 0-360. Pack default applies when unset. */
	primaryHue?: number;
	/** Initial theme mode. Pack default applies when unset. */
	defaultTheme?: DefaultThemeMode;
	/** Body / heading font family. Pack default applies when unset. */
	fontFamily?: FontFamily;
}

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
	/**
	 * Deprecated: use `theme.favicon` instead. When both are set the
	 * top-level value wins so existing sites keep working.
	 */
	favicon?: string;
	renderer?: string;
	/** Visual styling — see `ThemeConfig`. */
	theme?: ThemeConfig;
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
	/**
	 * Parsed OpenAPI documents keyed by the same relative path that appears in
	 * `openapiFiles`. Cached during mirroring so the rich-renderer pipeline
	 * does not need to re-read or re-parse the source files.
	 */
	openapiDocs: Record<string, OpenApiDocument>;
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
