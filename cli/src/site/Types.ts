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
 * sub-item, etc.
 */
export interface ExternalLink {
	label: string;
	url: string;
}

/**
 * Header navbar item — direct link (`url`) OR dropdown (`items`),
 * mutually exclusive.
 */
export interface HeaderItem {
	label: string;
	url?: string;
	items?: ExternalLink[];
}

/** Header navigation config in site.json. */
export interface HeaderConfig {
	items: HeaderItem[];
	/** Primary CTA button rendered in the navbar (e.g. "Get Started"). */
	primary?: { label: string; href: string };
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
	/** Alias for `twitter`. When set and `twitter` is not, treated as `twitter`. */
	x?: string;
	discord?: string;
	linkedin?: string;
	youtube?: string;
	bluesky?: string;
}

/** Footer config in site.json. */
export interface FooterConfig {
	copyright?: string;
	columns?: FooterColumn[];
	socialLinks?: SocialLinks;
	/**
	 * Deprecated nested-shape alias for `socialLinks`. Coerced to `socialLinks`
	 * at site.json load time; `socialLinks` wins when both are set.
	 */
	social?: SocialLinks;
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
			/**
			 * Optional icon prepended to the sidebar item title. Accepts emoji
			 * or short text (e.g. `"📖"`, `"🔧"`). Composed into the display
			 * title at `_meta.js` generation time since Nextra v4 has no native
			 * icon field.
			 */
			icon?: string;
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
 * A `ThemePack` value is a theme pack name, a path, or a package reference:
 *   - `"forge"` / `"atlas"` — well-known external packs (installed via npm or GitHub)
 *   - `"default"` — vanilla `nextra-theme-docs` (no pack CSS)
 *   - `"./my-theme.js"` — local file path (resolved relative to source root)
 *   - `"@acme/docs-theme"` — npm package name
 *
 * The `(string & {})` intersection keeps TypeScript's autocomplete for
 * well-known names while accepting any arbitrary string.
 */
export type ThemePack = "default" | "forge" | "atlas" | (string & {});

/**
 * Initial colour scheme for visitors.
 *   - `"light"` / `"dark"` — forced mode
 *   - `"system"` — follows the OS preference (via `prefers-color-scheme`)
 */
export type DefaultThemeMode = "light" | "dark" | "system";

/**
 * Font families a pack can resolve via Google Fonts.
 *   - `"inter"` — neutral sans-serif (Forge default)
 *   - `"space-grotesk"` — geometric sans
 *   - `"ibm-plex"` — IBM Plex Sans
 *   - `"source-sans"` — Source Sans 3
 *   - `"source-serif"` — Source Serif 4 (Atlas default)
 */
export type FontFamily = "inter" | "space-grotesk" | "ibm-plex" | "source-sans" | "source-serif";

/**
 * How the navbar logo composes its image and text parts:
 *   - `"text"`  — render only the logo text (defaults to `title`, or `logoText` if set)
 *   - `"image"` — render only the logo image (`logoUrl`); falls back to text if `logoUrl` is unset
 *   - `"both"`  — render image followed by text
 *
 * When `logoDisplay` is unset, the layout infers `"both"` if `logoUrl` is set
 * and `"text"` otherwise — preserving pre-`logoDisplay` behaviour.
 */
export type LogoDisplay = "text" | "image" | "both";

/**
 * Visual theme block in site.json. All fields are optional; each pack's
 * manifest supplies defaults (e.g. Forge defaults to `primaryHue: 228`,
 * `defaultTheme: "light"`, `fontFamily: "inter"`).
 */
export interface ThemeConfig {
	pack?: ThemePack;
	/** Image URL for logo (light mode and fallback when `logoUrlDark` is unset). */
	logoUrl?: string;
	/** Optional dark-mode logo variant. The pack swaps when `.dark` is active. */
	logoUrlDark?: string;
	/**
	 * Custom logo text. When unset, the site `title` is used. Useful when the
	 * page title ("Acme Documentation") differs from the brand wordmark ("ACME").
	 */
	logoText?: string;
	/**
	 * Whether the navbar logo shows the image, the text, or both. See
	 * `LogoDisplay` for the resolution rules. The auto-default preserves
	 * pre-`logoDisplay` behaviour, so existing sites need no change.
	 */
	logoDisplay?: LogoDisplay;
	/**
	 * Favicon URL. When the legacy top-level `favicon` field is also set, the
	 * top-level value wins (deprecated alias kept for back-compat).
	 */
	favicon?: string;
	/**
	 * Primary accent colour as a hex string (e.g. `"#3B82F6"`).
	 * This is the canonical colour field — preferred over `primaryHue`.
	 * When both are set, `primaryColor` wins.
	 */
	primaryColor?: string;
	/**
	 * @deprecated Use `primaryColor` instead.
	 * Primary accent hue 0–360 (HSL colour wheel).
	 * Superseded by `primaryColor` or `colors.primary` when set.
	 */
	primaryHue?: number;
	/**
	 * Richer colour model using hex values. When set, `colors.primary` takes
	 * precedence over `primaryHue` and `primaryColor`.
	 *   - `primary` — main accent colour (hex, e.g. `"#4F46E5"`)
	 *   - `light`   — lighter variant for hover/soft backgrounds (auto-derived if omitted)
	 *   - `dark`    — variant used in dark mode (auto-derived if omitted)
	 */
	colors?: {
		primary: string;
		light?: string;
		dark?: string;
	};
	/**
	 * Custom page background colour per colour scheme. When set, the pack
	 * stylesheet emits CSS custom properties that override the pack default.
	 *   - `light` — background for light mode (hex, e.g. `"#FAFAFA"`)
	 *   - `dark`  — background for dark mode (hex, e.g. `"#0A0A0A"`)
	 */
	background?: {
		light?: string;
		dark?: string;
	};
	/**
	 * Initial colour scheme for visitors.
	 * Pack defaults: Forge → `"light"`, Atlas → `"dark"`, Default → `"system"`.
	 */
	defaultTheme?: DefaultThemeMode;
	/**
	 * Body / heading font family resolved via Google Fonts.
	 * Pack defaults: Forge → `"inter"`, Atlas → `"source-serif"`.
	 */
	fontFamily?: FontFamily;
}

/**
 * Logo subfields under `branding.logo`. The canonical shape is the flat
 * `theme.logoUrl` / `theme.logoText` etc. — `BrandingConfig` is read as a
 * deprecated alias and coerced into `theme` at site.json load time.
 */
export interface BrandingLogoConfig {
	text?: string;
	image?: string;
	imageDark?: string;
	display?: LogoDisplay;
	/** Schema-compatibility passthrough — currently ignored by the CLI renderer. */
	alt?: string;
}

/**
 * Visual branding block — the deprecated nested-shape alias for `theme`.
 * Mapping happens at load time in `SiteJsonReader.coerceBrandingToTheme`.
 * When both `branding` and `theme` are present, `theme.*` wins (so callers
 * can override a single field without rewriting the whole block).
 */
export interface BrandingConfig {
	themePack?: ThemePack;
	logo?: BrandingLogoConfig;
	favicon?: string;
	colors?: { primaryHue?: number };
	fontFamily?: FontFamily;
	defaultTheme?: DefaultThemeMode;
}

/**
 * A persistent link rendered at the bottom of the sidebar (below the
 * navigation tree). Typically used for Blog, Community, Changelog, etc.
 */
export interface AnchorItem {
	label: string;
	href: string;
	icon?: string;
}

// ─── Navigation types ────────────────────────────────────────────────────────

/**
 * An article is a navigable sidebar item. Can nest child articles as a
 * collapsible dropdown.
 */
export interface NavigationArticle {
	article: string;
	href: string;
	/**
	 * Optional source markdown path (relative to the source root, with or
	 * without `.md` / `.mdx`). When set, `navigation` becomes fully
	 * declarative: the logical target route comes from `href`, while the
	 * physical source file comes from `source`.
	 *
	 * When omitted, the CLI falls back to resolving the source file from
	 * `href` using legacy heuristic matching.
	 */
	source?: string;
	type?: "external";
	articles?: NavigationArticle[];
	expanded?: boolean;
}

/**
 * A group is a non-clickable section heading that clusters articles.
 * Groups cannot nest inside other groups.
 */
export interface NavigationGroup {
	group: string;
	root?: string;
	/**
	 * Optional physical source directory for this logical group, relative to
	 * the source root. Lets a group render under one logical target folder
	 * while sourcing its child pages from a different directory tree.
	 */
	sourceRoot?: string;
	content: NavigationArticle[];
}

/**
 * A navigation page — a named top-level section.
 * Pages may only appear at the root of `navigation`.
 *
 * Takes one of three forms:
 *   - Content page: `page` + `root` + `content` (groups/articles)
 *   - OpenAPI page: `page` + `openapi` (auto-rendered from spec)
 *   - Menu page:    `page` + `type: "menu"` + `items` (navbar dropdown)
 */
export interface NavigationPage {
	page: string;
	root?: string;
	/**
	 * Optional physical source directory for this logical page, relative to
	 * the source root. When set, child pages resolve from this directory
	 * regardless of the page's logical target root.
	 */
	sourceRoot?: string;
	content?: (NavigationGroup | NavigationArticle)[];
	openapi?: string;
	/** When `"menu"`, the page renders as a navbar dropdown instead of a content section. */
	type?: "menu";
	/** Links displayed in the dropdown. Only valid when `type` is `"menu"`. */
	items?: NavigationMenuItem[];
}

/** A link entry inside a menu page dropdown. */
export interface NavigationMenuItem {
	label: string;
	url: string;
}

/**
 * The `navigation` field in site.json. Two modes:
 *   - Page mode: `NavigationPage[]` — multiple named top-level sections,
 *     each rendered as a page tab in the navbar.
 *   - Simple mode: `(NavigationGroup | NavigationArticle)[]` — config-driven
 *     sidebar without pages. Replaces the deprecated `sidebar` field.
 *
 * When absent, the sidebar is auto-generated from the filesystem.
 * Priority: `navigation` > `sidebar` (legacy) > filesystem.
 */
export type Navigation = NavigationPage[] | (NavigationGroup | NavigationArticle)[];

// ─── Backward compatibility aliases ─────────────────────────────────────────
// These aliases keep existing code (StructureParser, tests) compiling while
// the canonical names are now Navigation*.
/** @deprecated Use `NavigationArticle` */
export type StructureArticle = NavigationArticle;
/** @deprecated Use `NavigationGroup` */
export type StructureGroup = NavigationGroup;
/** @deprecated Use `NavigationArticle | NavigationGroup` */
export type StructureNode = NavigationArticle | NavigationGroup;

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
	/** Header navbar — supports per-item dropdowns. */
	header?: HeaderConfig;
	/** Site footer — copyright, columns of links, and social-icon URLs. */
	footer?: FooterConfig;
	/**
	 * Legacy sidebar overrides — per-directory label/ordering map.
	 * @deprecated Use `navigation` instead. When `navigation` is present,
	 * `sidebar` is ignored.
	 */
	sidebar?: SidebarOverrides;
	/**
	 * Content navigation tree. Two modes:
	 *   - Page mode: `NavigationPage[]` — multiple named top-level sections
	 *   - Simple mode: `(NavigationGroup | NavigationArticle)[]` — config-driven
	 *     sidebar without pages
	 *
	 * When absent, falls back to `sidebar` (legacy) or filesystem auto-discovery.
	 */
	navigation?: Navigation;
	/**
	 * Persistent links rendered at the bottom of the sidebar — Blog,
	 * Community, Discord, etc. Each item has a label, href, and optional
	 * icon (emoji or text prefix).
	 */
	anchors?: AnchorItem[];
	pathMappings?: PathMappings;
	/**
	 * Deprecated: use `theme.favicon` instead. When both are set the
	 * top-level value wins so existing sites keep working.
	 */
	favicon?: string;
	renderer?: string;
	/** Visual styling — see `ThemeConfig`. */
	theme?: ThemeConfig;
	/**
	 * Deprecated nested-shape alias for `theme`. Coerced to `theme.*` at
	 * site.json load time; `theme.*` wins when both are set. New site.json
	 * files should use `theme` directly.
	 */
	branding?: BrandingConfig;
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
