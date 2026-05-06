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
			header,
			footer,
			theme: undefined,
			legacyFavicon: undefined,
		});
		expect(result.header).toBe(header);
		expect(result.footer).toBe(footer);
	});

	it("propagates theme.logoText and theme.logoDisplay to the resolved input", () => {
		const result = resolveAtlasLayoutInput({
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

	it("uses logoText for the logo span when set, instead of title", () => {
		const result = generateAtlasLayoutTsx({ ...BASE_INPUT, logoText: "ACME" });
		expect(result).toContain('<span>{"ACME"}</span>');
		expect(result).not.toContain('<span>{"Acme Handbook"}</span>');
	});

	it("logoDisplay='text' suppresses the image even when logoUrl is set", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			logoUrl: "/logo.svg",
			logoDisplay: "text",
		});
		expect(result).not.toContain("<img ");
		expect(result).toContain('<span>{"Acme Handbook"}</span>');
	});

	it("logoDisplay='image' suppresses the text span when logoUrl is set", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			logoUrl: "/logo.svg",
			logoDisplay: "image",
		});
		expect(result).toContain("<img ");
		expect(result).not.toContain('<span>{"Acme Handbook"}</span>');
	});

	it("logoDisplay='image' falls back to text when logoUrl is unset", () => {
		const result = generateAtlasLayoutTsx({ ...BASE_INPUT, logoDisplay: "image" });
		expect(result).not.toContain("<img ");
		expect(result).toContain('<span>{"Acme Handbook"}</span>');
	});

	it("logoDisplay='both' renders image + text together", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			logoUrl: "/logo.svg",
			logoText: "ACME",
			logoDisplay: "both",
		});
		expect(result).toContain('<img src={"/logo.svg"}');
		expect(result).toContain('<span>{"ACME"}</span>');
	});

	it("includes the favicon <link> when configured and omits it when not", () => {
		expect(generateAtlasLayoutTsx(BASE_INPUT)).not.toContain('rel="icon"');
		const withFavicon = generateAtlasLayoutTsx({ ...BASE_INPUT, favicon: "/favicon.ico" });
		expect(withFavicon).toContain('<link rel="icon" href={"/favicon.ico"}');
	});

	it("sanitizes javascript: URLs in favicon and logoUrl to '#'", () => {
		const favResult = generateAtlasLayoutTsx({ ...BASE_INPUT, favicon: "javascript:alert(1)" });
		expect(favResult).not.toMatch(/javascript:alert/i);

		const logoResult = generateAtlasLayoutTsx({ ...BASE_INPUT, logoUrl: "javascript:alert(1)" });
		expect(logoResult).not.toMatch(/javascript:alert/i);
		expect(logoResult).toContain('<img src={"#"}');
	});

	it("renders <Navbar> with no JSX children — nav items go through _meta.js", () => {
		const result = generateAtlasLayoutTsx(BASE_INPUT);
		// New architecture: Atlas's navbar has only the logo prop, no
		// children. Page tabs come from the root _meta.js (Nextra renders
		// them natively with chevron / hover / mobile drawer). The layout
		// input no longer carries `nav` at all — enforced at the type level.
		expect(result).toContain("<Navbar logo={<SiteLogo />} />");
	});

	it("uses <ScopedNextraLayout> instead of vanilla <Layout>", () => {
		const result = generateAtlasLayoutTsx(BASE_INPUT);
		expect(result).toContain("import ScopedNextraLayout from '../components/ScopedNextraLayout'");
		expect(result).toContain("<ScopedNextraLayout");
		expect(result).toContain("</ScopedNextraLayout>");
	});

	// ── footer (semantic classes — pack CSS targets these) ───────────────────

	it("renders default copyright footer when no footer config is set", () => {
		const result = generateAtlasLayoutTsx(BASE_INPUT);
		expect(result).toContain("<Footer>");
		expect(result).toContain("atlas-footer-masthead");
	});

	it("emits atlas-footer wrapper class when footer config is set", () => {
		const result = generateAtlasLayoutTsx({
			...BASE_INPUT,
			footer: { copyright: "2026 Acme Inc." },
		});
		expect(result).toContain('className="atlas-footer"');
		expect(result).toContain('className="atlas-footer-bottom"');
		expect(result).toContain('className="atlas-footer-masthead"');
		expect(result).toContain('className="atlas-footer-copy"');
		expect(result).toContain("2026 Acme Inc.");
	});

	it("emits atlas-footer-columns and atlas-footer-col classes for columns", () => {
		const result = generateAtlasLayoutTsx({
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
		expect(result).toContain('className="atlas-footer-columns"');
		expect(result).toContain('className="atlas-footer-col"');
		expect(result).toContain("Product");
		expect(result).toContain('href="/pricing"');
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
