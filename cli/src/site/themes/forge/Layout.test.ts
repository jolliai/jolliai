/**
 * Tests for the Forge layout generator.
 *
 * Two surfaces:
 *   - `resolveForgeLayoutInput` — schema → ForgeLayoutInput resolution,
 *     including manifest defaults and the legacy top-level `favicon` alias.
 *   - `generateForgeLayoutTsx` — input → TSX string, covering the wrappers
 *     the Forge CSS depends on, font/favicon link rendering, logo slots,
 *     and URL sanitization.
 */

import { describe, expect, it } from "vitest";
import { buildForgeFontFamilyCssValue, generateForgeLayoutTsx, resolveForgeLayoutInput } from "./Layout.js";
import { FORGE_MANIFEST } from "./Manifest.js";

const BASE_INPUT = {
	title: "Acme Docs",
	description: "API reference + guides",
	nav: [],
	primaryHue: FORGE_MANIFEST.defaults.primaryHue,
	defaultTheme: FORGE_MANIFEST.defaults.defaultTheme,
	fontFamily: FORGE_MANIFEST.defaults.fontFamily,
};

// ─── resolveForgeLayoutInput ────────────────────────────────────────────────

describe("resolveForgeLayoutInput", () => {
	it("applies Forge manifest defaults when theme is undefined", () => {
		const result = resolveForgeLayoutInput({
			title: "T",
			description: "D",
			nav: [],
			theme: undefined,
			legacyFavicon: undefined,
		});
		expect(result.primaryHue).toBe(FORGE_MANIFEST.defaults.primaryHue);
		expect(result.defaultTheme).toBe(FORGE_MANIFEST.defaults.defaultTheme);
		expect(result.fontFamily).toBe(FORGE_MANIFEST.defaults.fontFamily);
	});

	it("honors theme overrides over manifest defaults", () => {
		const result = resolveForgeLayoutInput({
			title: "T",
			description: "D",
			nav: [],
			theme: { primaryHue: 200, defaultTheme: "dark", fontFamily: "source-serif" },
			legacyFavicon: undefined,
		});
		expect(result.primaryHue).toBe(200);
		expect(result.defaultTheme).toBe("dark");
		expect(result.fontFamily).toBe("source-serif");
	});

	it("legacy top-level favicon wins over theme.favicon (deprecated alias precedence)", () => {
		const result = resolveForgeLayoutInput({
			title: "T",
			description: "D",
			nav: [],
			theme: { favicon: "/theme.ico" },
			legacyFavicon: "/legacy.ico",
		});
		expect(result.favicon).toBe("/legacy.ico");
	});

	it("falls back to theme.favicon when legacy top-level is unset", () => {
		const result = resolveForgeLayoutInput({
			title: "T",
			description: "D",
			nav: [],
			theme: { favicon: "/theme.ico" },
			legacyFavicon: undefined,
		});
		expect(result.favicon).toBe("/theme.ico");
	});

	it("resolves the CSS font-family value for a given FontFamily key", () => {
		expect(buildForgeFontFamilyCssValue("inter")).toContain("Inter");
		expect(buildForgeFontFamilyCssValue("source-serif")).toContain("Source Serif 4");
	});

	it("passes through header and footer config", () => {
		const header = { items: [{ label: "Docs", url: "/docs" }] };
		const footer = { copyright: "2026 Acme" };
		const result = resolveForgeLayoutInput({
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

// ─── generateForgeLayoutTsx ─────────────────────────────────────────────────

describe("generateForgeLayoutTsx", () => {
	it("imports the Forge stylesheet at app/themes/forge.css", () => {
		const result = generateForgeLayoutTsx(BASE_INPUT);
		expect(result).toContain("import './themes/forge.css'");
	});

	it("imports the shared API stylesheet at ../styles/api.css", () => {
		// Forge sites still need API styling for OpenAPI pages — same singleton
		// stylesheet the default layout consumes, just tinted with Forge's hue
		// at write time (see NextraRenderer.initProject).
		const result = generateForgeLayoutTsx(BASE_INPUT);
		expect(result).toContain("import '../styles/api.css'");
	});

	it("renders the Forge wrapper elements that the CSS depends on", () => {
		const result = generateForgeLayoutTsx(BASE_INPUT);
		expect(result).toContain('className="forge-sidebar-logo"');
		expect(result).toContain('className="forge-sidebar-search"');
		expect(result).toContain('className="forge-navbar-logo"');
	});

	it("includes the Nextra <Search /> component in the sidebar wrapper", () => {
		const result = generateForgeLayoutTsx(BASE_INPUT);
		expect(result).toContain("<Search ");
	});

	it("interpolates primaryHue into the <Head color> prop", () => {
		const result = generateForgeLayoutTsx({ ...BASE_INPUT, primaryHue: 145 });
		expect(result).toContain("hue: 145, saturation: 84");
	});

	it("interpolates defaultTheme into the <Layout nextThemes> prop", () => {
		const result = generateForgeLayoutTsx({ ...BASE_INPUT, defaultTheme: "dark" });
		expect(result).toContain('defaultTheme: "dark"');
	});

	it("emits the Google Fonts <link> for the chosen font family", () => {
		const inter = generateForgeLayoutTsx({ ...BASE_INPUT, fontFamily: "inter" });
		expect(inter).toContain("fonts.googleapis.com/css2?family=Inter");

		const serif = generateForgeLayoutTsx({ ...BASE_INPUT, fontFamily: "source-serif" });
		expect(serif).toContain("fonts.googleapis.com/css2?family=Source+Serif+4");
	});

	it("omits the favicon <link> when no favicon is configured", () => {
		const result = generateForgeLayoutTsx(BASE_INPUT);
		expect(result).not.toContain('rel="icon"');
	});

	it("includes the favicon <link> when configured", () => {
		const result = generateForgeLayoutTsx({ ...BASE_INPUT, favicon: "/favicon.ico" });
		expect(result).toContain('<link rel="icon" href={"/favicon.ico"}');
	});

	it("renders only the text logo span when no logoUrl is set", () => {
		const result = generateForgeLayoutTsx(BASE_INPUT);
		expect(result).not.toContain("<img ");
		expect(result).toContain('<span>{"Acme Docs"}</span>');
	});

	it("renders a single light-mode <img> when only logoUrl is set", () => {
		const result = generateForgeLayoutTsx({ ...BASE_INPUT, logoUrl: "/logo.svg" });
		expect(result).toContain('<img src={"/logo.svg"} alt={"Acme Docs"}');
		expect(result).not.toContain("forge-logo-dark");
	});

	it("renders paired light+dark <img>s with swap classes when both URLs are set", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			logoUrl: "/light.svg",
			logoUrlDark: "/dark.svg",
		});
		expect(result).toContain('className="forge-logo-light"');
		expect(result).toContain('className="forge-logo-dark"');
		expect(result).toContain('<img src={"/light.svg"}');
		expect(result).toContain('<img src={"/dark.svg"}');
	});

	it("renders nav items as <a> children of <Navbar> alongside <ThemeSwitch />", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			nav: [
				{ label: "Guides", href: "/guides" },
				{ label: "GitHub", href: "https://github.com/acme" },
			],
		});
		expect(result).toContain('href={"/guides"}');
		expect(result).toContain('{"Guides"}');
		expect(result).toContain('href={"https://github.com/acme"}');
		expect(result).toContain('{"GitHub"}');
		expect(result).toContain("<ThemeSwitch />");
	});

	it("sanitizes javascript: URLs in nav hrefs to '#'", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			nav: [{ label: "Bad", href: "javascript:alert(1)" }],
		});
		expect(result).not.toMatch(/javascript:alert/i);
		expect(result).toContain('<a href={"#"}');
	});

	it("sanitizes javascript: URLs in favicon to '#'", () => {
		const result = generateForgeLayoutTsx({ ...BASE_INPUT, favicon: "javascript:alert(1)" });
		expect(result).not.toMatch(/javascript:alert/i);
		expect(result).toContain('<link rel="icon" href={"#"}');
	});

	it("sanitizes javascript: URLs in logoUrl to '#'", () => {
		const result = generateForgeLayoutTsx({ ...BASE_INPUT, logoUrl: "javascript:alert(1)" });
		expect(result).not.toMatch(/javascript:alert/i);
		expect(result).toContain('<img src={"#"}');
	});

	it("title with embedded quotes survives JSON-stringification into the alt attribute", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			title: 'Acme "Tools"',
			logoUrl: "/logo.svg",
		});
		expect(result).toContain('alt={"Acme \\"Tools\\""}');
	});

	// ── header.items support ─────────────────────────────────────────────────

	it("prefers header.items over legacy nav when both are set", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			nav: [{ label: "FromNav", href: "/nav" }],
			header: { items: [{ label: "FromHeader", url: "/header" }] },
		});
		expect(result).toContain("FromHeader");
		expect(result).not.toContain("FromNav");
	});

	it("renders a <details> dropdown when a header item has sub-items", () => {
		const result = generateForgeLayoutTsx({
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
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			header: { items: [{ label: "Docs", url: "/docs" }] },
		});
		expect(result).toContain('href={"/docs"}');
		expect(result).toContain('{"Docs"}');
		expect(result).not.toContain("<details");
	});

	it("falls back to '#' for header items with no url and no sub-items", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			header: { items: [{ label: "Empty" }] },
		});
		expect(result).toContain('href={"#"}');
	});

	it("sanitizes javascript: URLs in header dropdown sub-items", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			header: {
				items: [{ label: "Menu", items: [{ label: "Bad", url: "javascript:alert(1)" }] }],
			},
		});
		expect(result).not.toMatch(/javascript:alert/i);
		expect(result).toContain('href={"#"}');
	});

	it("falls back to legacy nav when header.items is empty", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			nav: [{ label: "NavLink", href: "/nav" }],
			header: { items: [] },
		});
		expect(result).toContain("NavLink");
	});

	// ── footer support ───────────────────────────────────────────────────────

	it("renders default copyright footer when no footer config is set", () => {
		const result = generateForgeLayoutTsx(BASE_INPUT);
		expect(result).toContain("<Footer>");
		expect(result).toContain("new Date().getFullYear()");
	});

	it("renders footer copyright text", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			footer: { copyright: "2026 Acme Inc." },
		});
		expect(result).toContain("<Footer>");
		expect(result).toContain('{"2026 Acme Inc."}');
	});

	it("renders footer columns with titles and links", () => {
		const result = generateForgeLayoutTsx({
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
		const result = generateForgeLayoutTsx({
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
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			footer: { columns: [], socialLinks: {} },
		});
		expect(result).toContain("new Date().getFullYear()");
	});

	it("sanitizes javascript: URLs in footer links and social links", () => {
		const result = generateForgeLayoutTsx({
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
