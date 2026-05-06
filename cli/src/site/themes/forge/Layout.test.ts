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
			theme: { favicon: "/theme.ico" },
			legacyFavicon: "/legacy.ico",
		});
		expect(result.favicon).toBe("/legacy.ico");
	});

	it("falls back to theme.favicon when legacy top-level is unset", () => {
		const result = resolveForgeLayoutInput({
			title: "T",
			description: "D",
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
			header,
			footer,
			theme: undefined,
			legacyFavicon: undefined,
		});
		expect(result.header).toBe(header);
		expect(result.footer).toBe(footer);
	});

	it("propagates theme.logoText and theme.logoDisplay to the resolved input", () => {
		const result = resolveForgeLayoutInput({
			title: "T",
			description: "D",
			theme: { logoText: "ACME", logoDisplay: "image", logoUrl: "/logo.svg" },
			legacyFavicon: undefined,
		});
		expect(result.logoText).toBe("ACME");
		expect(result.logoDisplay).toBe("image");
		expect(result.logoUrl).toBe("/logo.svg");
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

	it("uses logoText for the logo span when set, instead of title", () => {
		const result = generateForgeLayoutTsx({ ...BASE_INPUT, logoText: "ACME" });
		expect(result).toContain('<span>{"ACME"}</span>');
		expect(result).not.toContain('<span>{"Acme Docs"}</span>');
	});

	it("logoDisplay='text' suppresses the image even when logoUrl is set", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			logoUrl: "/logo.svg",
			logoDisplay: "text",
		});
		expect(result).not.toContain("<img ");
		expect(result).toContain('<span>{"Acme Docs"}</span>');
	});

	it("logoDisplay='image' suppresses the text span when logoUrl is set", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			logoUrl: "/logo.svg",
			logoDisplay: "image",
		});
		expect(result).toContain("<img ");
		// The forge-navbar-logo wrapper still wraps the image, but no inner <span> with the title text.
		expect(result).not.toContain('<span>{"Acme Docs"}</span>');
	});

	it("logoDisplay='image' falls back to text when logoUrl is unset (avoids empty navbar logo)", () => {
		const result = generateForgeLayoutTsx({ ...BASE_INPUT, logoDisplay: "image" });
		expect(result).not.toContain("<img ");
		expect(result).toContain('<span>{"Acme Docs"}</span>');
	});

	it("logoDisplay='both' renders image + text together", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			logoUrl: "/logo.svg",
			logoText: "ACME",
			logoDisplay: "both",
		});
		expect(result).toContain('<img src={"/logo.svg"}');
		expect(result).toContain('<span>{"ACME"}</span>');
	});

	it("renders <Navbar> with only <ThemeSwitch /> as children — nav items go through _meta.js", () => {
		const result = generateForgeLayoutTsx(BASE_INPUT);
		// New architecture: nav items are NOT spliced into the layout JSX.
		// MetaGenerator writes them to root _meta.js where Nextra renders
		// them natively (chevron / hover / mobile drawer). The layout input
		// no longer carries `nav` at all — enforced at the type level.
		expect(result).toContain("<Navbar logo={<SiteLogo />}><ThemeSwitch /></Navbar>");
	});

	it("uses <ScopedNextraLayout> instead of vanilla <Layout>", () => {
		const result = generateForgeLayoutTsx(BASE_INPUT);
		expect(result).toContain("import ScopedNextraLayout from '../components/ScopedNextraLayout'");
		expect(result).toContain("<ScopedNextraLayout");
		expect(result).toContain("</ScopedNextraLayout>");
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

	// ── footer (semantic classes — pack CSS targets these) ───────────────────

	it("renders default copyright footer when no footer config is set", () => {
		const result = generateForgeLayoutTsx(BASE_INPUT);
		expect(result).toContain("<Footer>");
		expect(result).toContain("new Date().getFullYear()");
	});

	it("emits forge-footer wrapper class when footer config is set", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			footer: { copyright: "2026 Acme Inc." },
		});
		expect(result).toContain('className="forge-footer"');
		expect(result).toContain('className="forge-footer-bottom"');
		expect(result).toContain('className="forge-footer-copyright"');
		expect(result).toContain('className="forge-footer-powered"');
		expect(result).toContain("2026 Acme Inc.");
	});

	it("emits forge-footer-columns and forge-footer-col classes for columns", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			footer: {
				columns: [
					{
						title: "Product",
						links: [{ label: "Pricing", url: "/pricing" }],
					},
				],
			},
		});
		expect(result).toContain('className="forge-footer-columns"');
		expect(result).toContain('className="forge-footer-col"');
		expect(result).toContain("Product");
		expect(result).toContain('href="/pricing"');
	});

	it("emits forge-footer-social wrapper for social-icon links", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			footer: { socialLinks: { github: "https://gh.example" } },
		});
		expect(result).toContain('className="forge-footer-social"');
		expect(result).toContain('className="forge-footer-social-github"');
		expect(result).toContain("https://gh.example");
	});

	it("sanitizes javascript: URLs in footer links and social links", () => {
		const result = generateForgeLayoutTsx({
			...BASE_INPUT,
			footer: {
				columns: [{ title: "X", links: [{ label: "Bad", url: "javascript:alert(1)" }] }],
				socialLinks: { github: "javascript:evil" },
			},
		});
		expect(result).not.toContain("javascript:alert");
		expect(result).not.toContain("javascript:evil");
	});
});
