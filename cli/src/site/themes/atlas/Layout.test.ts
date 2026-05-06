/**
 * Tests for the Atlas layout generator.
 *
 * Two surfaces:
 *   - `resolveAtlasLayoutInput` — schema → AtlasLayoutInput resolution,
 *     including manifest defaults (notably the dark / serif defaults that
 *     differentiate Atlas from Forge) and the legacy top-level `favicon`
 *     alias precedence.
 *   - `generateAtlasLayoutTsx` — input → TSX string, covering the navbar
 *     logo wrapper Atlas's CSS depends on, font/favicon link rendering,
 *     logo slot variants, URL sanitization, and the `toc.title = "Contents"`
 *     editorial detail.
 */

import { describe, expect, it } from "vitest";
import { buildAtlasFontFamilyCssValue, generateAtlasLayoutTsx, resolveAtlasLayoutInput } from "./Layout.js";
import { ATLAS_MANIFEST } from "./Manifest.js";

const BASE_INPUT = {
	title: "Acme Handbook",
	description: "Editorial-style content site",
	nav: [],
	primaryHue: ATLAS_MANIFEST.defaults.primaryHue,
	defaultTheme: ATLAS_MANIFEST.defaults.defaultTheme,
	fontFamily: ATLAS_MANIFEST.defaults.fontFamily,
};

// ─── resolveAtlasLayoutInput ────────────────────────────────────────────────

describe("resolveAtlasLayoutInput", () => {
	it("applies Atlas manifest defaults when theme is undefined (dark + serif)", () => {
		const result = resolveAtlasLayoutInput({
			title: "T",
			description: "D",
			nav: [],
			theme: undefined,
			legacyFavicon: undefined,
		});
		expect(result.primaryHue).toBe(200);
		expect(result.defaultTheme).toBe("dark");
		expect(result.fontFamily).toBe("source-serif");
	});

	it("honors theme overrides over manifest defaults", () => {
		const result = resolveAtlasLayoutInput({
			title: "T",
			description: "D",
			nav: [],
			theme: { primaryHue: 30, defaultTheme: "light", fontFamily: "ibm-plex" },
			legacyFavicon: undefined,
		});
		expect(result.primaryHue).toBe(30);
		expect(result.defaultTheme).toBe("light");
		expect(result.fontFamily).toBe("ibm-plex");
	});

	it("legacy top-level favicon wins over theme.favicon (deprecated alias precedence)", () => {
		const result = resolveAtlasLayoutInput({
			title: "T",
			description: "D",
			nav: [],
			theme: { favicon: "/theme.ico" },
			legacyFavicon: "/legacy.ico",
		});
		expect(result.favicon).toBe("/legacy.ico");
	});

	it("resolves the CSS font-family value for a given FontFamily key", () => {
		expect(buildAtlasFontFamilyCssValue("source-serif")).toContain("Source Serif 4");
		expect(buildAtlasFontFamilyCssValue("inter")).toContain("Inter");
	});

	it("passes through header and footer config", () => {
		const header = { items: [{ label: "Docs", url: "/docs" }] };
		const footer = { copyright: "2026 Acme" };
		const result = resolveAtlasLayoutInput({
			title: "T",
			description: "D",
			nav: [],
			header,
			footer,
			theme: undefined,
			legacyFavicon: undefined,
		});
		expect(result.header).toBe(header);
		expect(result.footer).toBe(footer);
	});
});

// ─── generateAtlasLayoutTsx ─────────────────────────────────────────────────

describe("generateAtlasLayoutTsx", () => {
	it("imports the Atlas stylesheet and the shared API stylesheet", () => {
		const result = generateAtlasLayoutTsx(BASE_INPUT);
		expect(result).toContain("import './themes/atlas.css'");
		expect(result).toContain("import '../styles/api.css'");
	});

	it("renders the Atlas navbar logo wrapper that the CSS depends on", () => {
		const result = generateAtlasLayoutTsx(BASE_INPUT);
		expect(result).toContain('className="atlas-navbar-logo"');
	});

	it("does NOT render a sidebar logo or sidebar-search wrapper (Atlas-specific layout)", () => {
		const result = generateAtlasLayoutTsx(BASE_INPUT);
		expect(result).not.toContain("atlas-sidebar-logo");
		expect(result).not.toContain("atlas-sidebar-search");
	});

	it("uses Atlas's saturation (70) in <Head color>, not Forge's 84", () => {
		const result = generateAtlasLayoutTsx({ ...BASE_INPUT, primaryHue: 145 });
		expect(result).toContain("hue: 145, saturation: 70");
		expect(result).not.toContain("saturation: 84");
	});

	it("passes toc={{ title: 'Contents' }} to <Layout> for Atlas's editorial label", () => {
		const result = generateAtlasLayoutTsx(BASE_INPUT);
		expect(result).toContain("toc={{ title: 'Contents' }}");
	});

	it("interpolates defaultTheme into <Layout nextThemes>", () => {
		const result = generateAtlasLayoutTsx({ ...BASE_INPUT, defaultTheme: "system" });
		expect(result).toContain('defaultTheme: "system"');
	});

	it("emits the Source Serif 4 Google Fonts <link> by default", () => {
		const result = generateAtlasLayoutTsx(BASE_INPUT);
		expect(result).toContain("fonts.googleapis.com/css2?family=Source+Serif+4");
	});

	it("renders a single light-mode <img> when only logoUrl is set (no dark swap)", () => {
		const result = generateAtlasLayoutTsx({ ...BASE_INPUT, logoUrl: "/logo.svg" });
		expect(result).toContain('<img src={"/logo.svg"} alt={"Acme Handbook"}');
		expect(result).not.toContain("atlas-logo-dark");
	});

	it("renders paired light+dark <img>s with atlas-logo-light/dark classes when both set", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			logoUrl: "/light.svg",
			logoUrlDark: "/dark.svg",
		});
		expect(result).toContain('className="atlas-logo-light"');
		expect(result).toContain('className="atlas-logo-dark"');
	});

	it("includes the favicon <link> when configured and omits it when not", () => {
		expect(generateAtlasLayoutTsx(BASE_INPUT)).not.toContain('rel="icon"');
		const withFavicon = generateAtlasLayoutTsx({ ...BASE_INPUT, favicon: "/favicon.ico" });
		expect(withFavicon).toContain('<link rel="icon" href={"/favicon.ico"}');
	});

	it("sanitizes javascript: URLs in nav, favicon, and logoUrl to '#'", () => {
		const navResult = generateAtlasLayoutTsx({
			...BASE_INPUT,
			nav: [{ label: "Bad", href: "javascript:alert(1)" }],
		});
		expect(navResult).not.toMatch(/javascript:alert/i);
		expect(navResult).toContain('<a href={"#"}');

		const favResult = generateAtlasLayoutTsx({ ...BASE_INPUT, favicon: "javascript:alert(1)" });
		expect(favResult).not.toMatch(/javascript:alert/i);

		const logoResult = generateAtlasLayoutTsx({ ...BASE_INPUT, logoUrl: "javascript:alert(1)" });
		expect(logoResult).not.toMatch(/javascript:alert/i);
		expect(logoResult).toContain('<img src={"#"}');
	});

	it("renders nav items as <a> children of <Navbar> (Atlas keeps the legacy nav shorthand support)", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			nav: [{ label: "Guides", href: "/guides" }],
		});
		expect(result).toContain('href={"/guides"}');
		expect(result).toContain('{"Guides"}');
	});

	// ── header.items support ─────────────────────────────────────────────────

	it("prefers header.items over legacy nav when both are set", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			nav: [{ label: "FromNav", href: "/nav" }],
			header: { items: [{ label: "FromHeader", url: "/header" }] },
		});
		expect(result).toContain("FromHeader");
		expect(result).not.toContain("FromNav");
	});

	it("renders a <details> dropdown when a header item has sub-items", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			header: {
				items: [
					{
						label: "Resources",
						items: [
							{ label: "Blog", url: "/blog" },
							{ label: "Changelog", url: "/changelog" },
						],
					},
				],
			},
		});
		expect(result).toContain("<details");
		expect(result).toContain("<summary");
		expect(result).toContain('{"Resources"}');
		expect(result).toContain('{"Blog"}');
		expect(result).toContain('href={"/blog"}');
	});

	it("renders a direct link for header items without sub-items", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			header: { items: [{ label: "Docs", url: "/docs" }] },
		});
		expect(result).toContain('href={"/docs"}');
		expect(result).not.toContain("<details");
	});

	it("falls back to '#' for header items with no url and no sub-items", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			header: { items: [{ label: "Empty" }] },
		});
		expect(result).toContain('href={"#"}');
	});

	it("sanitizes javascript: URLs in header dropdown sub-items", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			header: {
				items: [{ label: "Menu", items: [{ label: "Bad", url: "javascript:alert(1)" }] }],
			},
		});
		expect(result).not.toMatch(/javascript:alert/i);
		expect(result).toContain('href={"#"}');
	});

	it("falls back to legacy nav when header.items is empty", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			nav: [{ label: "NavLink", href: "/nav" }],
			header: { items: [] },
		});
		expect(result).toContain("NavLink");
	});

	// ── footer support ───────────────────────────────────────────────────────

	it("renders default copyright footer when no footer config is set", () => {
		const result = generateAtlasLayoutTsx(BASE_INPUT);
		expect(result).toContain("<Footer>");
		expect(result).toContain("new Date().getFullYear()");
	});

	it("renders footer copyright text", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			footer: { copyright: "2026 Acme Inc." },
		});
		expect(result).toContain("<Footer>");
		expect(result).toContain('{"2026 Acme Inc."}');
	});

	it("renders footer columns with titles and links", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			footer: {
				columns: [
					{
						title: "Product",
						links: [
							{ label: "Pricing", url: "/pricing" },
							{ label: "Docs", url: "/docs" },
						],
					},
				],
			},
		});
		expect(result).toContain('{"Product"}');
		expect(result).toContain('{"Pricing"}');
		expect(result).toContain('href={"/pricing"}');
	});

	it("renders footer social links in canonical platform order", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			footer: { socialLinks: { youtube: "https://yt.example", github: "https://gh.example" } },
		});
		const ghIdx = result.indexOf("gh.example");
		const ytIdx = result.indexOf("yt.example");
		expect(ghIdx).toBeGreaterThan(-1);
		expect(ytIdx).toBeGreaterThan(-1);
		expect(ghIdx).toBeLessThan(ytIdx);
	});

	it("renders default copyright footer when footer has no content", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			footer: { columns: [], socialLinks: {} },
		});
		expect(result).toContain("new Date().getFullYear()");
	});

	it("sanitizes javascript: URLs in footer links and social links", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			footer: {
				columns: [{ title: "X", links: [{ label: "Bad", url: "javascript:alert(1)" }] }],
				socialLinks: { github: "data:text/html,evil" },
			},
		});
		expect(result).not.toContain("javascript:alert");
		expect(result).not.toContain("data:text/html");
	});
});
