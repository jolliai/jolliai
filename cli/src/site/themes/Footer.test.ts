/**
 * Tests for the shared footer body builder used by Forge / Atlas.
 *
 * Two layers exercised:
 *   - Low-level helpers (`renderFooterColumns`, `renderSocialLinks`,
 *     `buildFooterScaffold`) — pack-agnostic JSX-string emitters.
 *   - High-level pack builders (`buildForgeFooterBody`, `buildAtlasFooterBody`) —
 *     compose the helpers into the pack-specific bottom-row shapes.
 *
 * The pack stylesheets in `themes/{forge,atlas}/Css.ts` target the exact
 * class names emitted here, so every assertion that pins a class is
 * load-bearing — losing one would visually break the rendered footer
 * even though the tree still emits "something".
 */

import { describe, expect, it } from "vitest";
import type { FooterConfig } from "../Types.js";
import {
	buildAtlasFooterBody,
	buildFooterScaffold,
	buildForgeFooterBody,
	renderFooterColumns,
	renderSocialLinks,
	SOCIAL_LABELS,
	SOCIAL_PLATFORMS,
} from "./Footer.js";

// ─── renderFooterColumns ─────────────────────────────────────────────────────

describe("renderFooterColumns", () => {
	it("returns empty string when columns is undefined", () => {
		expect(renderFooterColumns({}, "forge")).toBe("");
	});

	it("returns empty string when columns is an empty array", () => {
		expect(renderFooterColumns({ columns: [] }, "forge")).toBe("");
	});

	it("emits {prefix}-footer-columns wrapper with one {prefix}-footer-col per column", () => {
		const result = renderFooterColumns(
			{
				columns: [
					{ title: "Product", links: [{ label: "Pricing", url: "/pricing" }] },
					{ title: "Community", links: [{ label: "Discord", url: "https://discord.gg/x" }] },
				],
			},
			"forge",
		);
		expect(result).toContain('<div className="forge-footer-columns">');
		// Use a precise pattern (quote-terminated) so we don't double-count the
		// `forge-footer-col` substring inside `forge-footer-columns`.
		expect(result.match(/forge-footer-col"/g)?.length).toBe(2);
		expect(result).toContain("<h4>Product</h4>");
		expect(result).toContain("<h4>Community</h4>");
		expect(result).toContain('href="/pricing"');
		expect(result).toContain('href="https://discord.gg/x"');
	});

	it("uses the supplied class prefix (atlas) for atlas pack", () => {
		const result = renderFooterColumns({ columns: [{ title: "X", links: [{ label: "Y", url: "/y" }] }] }, "atlas");
		expect(result).toContain('<div className="atlas-footer-columns">');
		expect(result).toContain('<div className="atlas-footer-col">');
	});

	it("escapes HTML-special characters in column titles and link labels", () => {
		const result = renderFooterColumns(
			{
				columns: [{ title: 'Tools <"&">', links: [{ label: "A & B {c}", url: "/x" }] }],
			},
			"forge",
		);
		expect(result).not.toContain('<"&">');
		expect(result).toContain("&lt;");
		expect(result).toContain("&amp;");
		expect(result).toContain("&quot;");
		expect(result).toContain("&#123;");
		expect(result).toContain("&#125;");
	});

	it("sanitises javascript: link URLs to '#'", () => {
		const result = renderFooterColumns(
			{ columns: [{ title: "X", links: [{ label: "Bad", url: "javascript:alert(1)" }] }] },
			"forge",
		);
		expect(result).not.toMatch(/javascript:alert/i);
		expect(result).toContain('href="#"');
	});

	it("HTML-attribute-escapes URLs so quotes/angle-brackets cannot break the JSX `href` attribute", () => {
		// `sanitizeUrl` only enforces a scheme allow-list — it does NOT escape
		// HTML-special chars in the rest of the URL. Without `escapeHtml` on
		// top, a URL like `https://x.com/?q="bad"` would close the `href="…"`
		// JSX attribute prematurely and break the customer's TSX build. Pin
		// the escaping so a future refactor can't silently regress it.
		const result = renderFooterColumns(
			{
				columns: [
					{
						title: "Links",
						links: [
							{ label: "Quote", url: 'https://x.com/?q="bad"' },
							{ label: "Angle", url: "https://x.com/<a>" },
						],
					},
				],
			},
			"forge",
		);
		expect(result).not.toMatch(/href="https:\/\/x\.com\/\?q="/);
		expect(result).toContain("&quot;");
		expect(result).toContain("&lt;");
		expect(result).toContain("&gt;");
	});

	it("preserves http(s), mailto, tel, fragments, query strings, and relative paths", () => {
		const result = renderFooterColumns(
			{
				columns: [
					{
						title: "Links",
						links: [
							{ label: "Web", url: "https://example.com" },
							{ label: "Mail", url: "mailto:hi@example.com" },
							{ label: "Phone", url: "tel:+15551234567" },
							{ label: "Frag", url: "#anchor" },
							{ label: "Query", url: "?q=1" },
							{ label: "Rel", url: "../up" },
							{ label: "Abs", url: "/abs/path" },
						],
					},
				],
			},
			"forge",
		);
		expect(result).toContain('href="https://example.com"');
		expect(result).toContain('href="mailto:hi@example.com"');
		expect(result).toContain('href="tel:+15551234567"');
		expect(result).toContain('href="#anchor"');
		expect(result).toContain('href="?q=1"');
		expect(result).toContain('href="../up"');
		expect(result).toContain('href="/abs/path"');
	});
});

// ─── renderSocialLinks ───────────────────────────────────────────────────────

describe("renderSocialLinks", () => {
	it("returns empty string when socialLinks is undefined", () => {
		expect(renderSocialLinks(undefined, "forge")).toBe("");
	});

	it("returns empty string when no platforms are populated", () => {
		expect(renderSocialLinks({}, "forge")).toBe("");
	});

	it("emits one <a> per populated platform with platform-specific class and aria-label", () => {
		const result = renderSocialLinks({ github: "https://gh.example", twitter: "https://tw.example" }, "forge");
		expect(result).toContain('aria-label="GitHub"');
		expect(result).toContain('aria-label="Twitter"');
		expect(result).toContain('className="forge-footer-social-github"');
		expect(result).toContain('className="forge-footer-social-twitter"');
		expect(result).toContain('<div className="forge-footer-social">');
	});

	it("emits platforms in canonical SOCIAL_PLATFORMS order (github before youtube)", () => {
		const result = renderSocialLinks({ youtube: "https://yt.example", github: "https://gh.example" }, "forge");
		expect(result.indexOf("gh.example")).toBeLessThan(result.indexOf("yt.example"));
	});

	it("omits unpopulated platforms (does not emit empty <a>)", () => {
		const result = renderSocialLinks({ github: "https://gh.example" }, "forge");
		expect(result).toContain("github");
		for (const platform of SOCIAL_PLATFORMS) {
			if (platform === "github") continue;
			expect(result).not.toContain(`aria-label="${SOCIAL_LABELS[platform]}"`);
		}
	});

	it("treats empty-string URLs as unpopulated", () => {
		const result = renderSocialLinks({ github: "", twitter: "https://tw.example" }, "forge");
		expect(result).not.toContain("github");
		expect(result).toContain("twitter");
	});

	it("sanitises javascript: URLs to '#' and removes the script payload", () => {
		const result = renderSocialLinks({ github: "javascript:alert(1)" }, "forge");
		expect(result).not.toMatch(/javascript:alert/i);
		expect(result).toContain('href="#"');
	});

	it("HTML-attribute-escapes social URLs so quotes cannot break the JSX `href` attribute", () => {
		// Same defense as renderFooterColumns — `sanitizeUrl` doesn't escape
		// arbitrary chars after the scheme, so a malformed URL with `"` or
		// `<` would otherwise break the customer's TSX compile.
		const result = renderSocialLinks({ github: 'https://x.com/?q="bad"' }, "forge");
		expect(result).not.toMatch(/href="https:\/\/x\.com\/\?q="/);
		expect(result).toContain("&quot;");
	});

	it("uses the supplied class prefix for atlas pack", () => {
		const result = renderSocialLinks({ github: "https://gh.example" }, "atlas");
		expect(result).toContain("atlas-footer-social-github");
		expect(result).toContain('<div className="atlas-footer-social">');
	});
});

// ─── buildFooterScaffold ─────────────────────────────────────────────────────

describe("buildFooterScaffold", () => {
	it("emits the {prefix}-footer outer wrapper and {prefix}-footer-bottom inner wrapper", () => {
		const result = buildFooterScaffold("forge", "", ["<span>row</span>"]);
		expect(result).toContain('<div className="forge-footer">');
		expect(result).toContain('<div className="forge-footer-bottom">');
		expect(result).toContain("<span>row</span>");
	});

	it("includes the columns block when supplied", () => {
		const result = buildFooterScaffold("forge", '<div className="forge-footer-columns">x</div>', []);
		expect(result).toContain('<div className="forge-footer-columns">x</div>');
	});

	it("omits the columns block when an empty string is passed", () => {
		const result = buildFooterScaffold("forge", "", ["<span>only</span>"]);
		// The wrapper still appears (always emitted), but no columns div between the wrapper and the bottom block.
		expect(result).not.toContain("forge-footer-columns");
	});

	it("filters empty-string bottom rows so callers can pass socialJsx unconditionally", () => {
		const result = buildFooterScaffold("forge", "", [
			"<span>copyright</span>",
			"", // unpopulated social
			"<span>powered</span>",
		]);
		// All non-empty rows are present.
		expect(result).toContain("copyright");
		expect(result).toContain("powered");
		// The empty string did not produce an extra wrapper line.
		expect(result.match(/\n {12}\n/g)).toBeNull();
	});

	it("preserves the order of bottom rows", () => {
		const result = buildFooterScaffold("atlas", "", [
			"<span>first</span>",
			"<span>second</span>",
			"<span>third</span>",
		]);
		expect(result.indexOf("first")).toBeLessThan(result.indexOf("second"));
		expect(result.indexOf("second")).toBeLessThan(result.indexOf("third"));
	});
});

// ─── buildForgeFooterBody ────────────────────────────────────────────────────

describe("buildForgeFooterBody", () => {
	it("falls back to a year © siteName · Powered by Jolli line when footerConfig is undefined", () => {
		const result = buildForgeFooterBody("Acme Docs");
		expect(result).toContain("Acme Docs");
		expect(result).toContain("Powered by Jolli");
		expect(result).toContain("new Date().getFullYear()");
	});

	it("escapes HTML in the fallback siteName", () => {
		const result = buildForgeFooterBody('Acme "Tools" <suite>');
		expect(result).not.toContain('Acme "Tools" <suite>');
		expect(result).toContain("&quot;");
		expect(result).toContain("&lt;");
	});

	it("emits the configured copyright string with class forge-footer-copyright", () => {
		const config: FooterConfig = { copyright: "© 2026 Acme" };
		const result = buildForgeFooterBody("Acme Docs", config);
		expect(result).toContain('className="forge-footer-copyright"');
		expect(result).toContain("© 2026 Acme");
	});

	it("uses a default copyright (year © siteName) when footer block is set but copyright is unset", () => {
		const config: FooterConfig = { columns: [] };
		const result = buildForgeFooterBody("Acme", config);
		expect(result).toContain('className="forge-footer-copyright"');
		expect(result).toContain("Acme");
		expect(result).toContain("new Date().getFullYear()");
	});

	it("always emits the 'Powered by Jolli' branding span when columns or social or copyright are configured", () => {
		const result = buildForgeFooterBody("Acme", { copyright: "© Acme" });
		expect(result).toContain('className="forge-footer-powered"');
		expect(result).toContain("Powered by Jolli");
	});

	it("composes columns + social + copyright + powered branding in order", () => {
		const config: FooterConfig = {
			copyright: "© 2026 Acme",
			columns: [{ title: "X", links: [{ label: "Y", url: "/y" }] }],
			socialLinks: { github: "https://gh.example" },
		};
		const result = buildForgeFooterBody("Acme", config);
		expect(result.indexOf("forge-footer-columns")).toBeLessThan(result.indexOf("forge-footer-bottom"));
		expect(result.indexOf("forge-footer-copyright")).toBeLessThan(result.indexOf("forge-footer-social"));
		expect(result.indexOf("forge-footer-social")).toBeLessThan(result.indexOf("forge-footer-powered"));
	});

	it("escapes HTML in the customer-supplied copyright string", () => {
		const result = buildForgeFooterBody("X", { copyright: '<script>alert("x")</script>' });
		expect(result).not.toContain("<script>");
		expect(result).toContain("&lt;script&gt;");
	});
});

// ─── buildAtlasFooterBody ────────────────────────────────────────────────────

describe("buildAtlasFooterBody", () => {
	it("emits a masthead-style fallback wrapping the siteName when footerConfig is undefined", () => {
		const result = buildAtlasFooterBody("Acme");
		expect(result).toContain('className="atlas-footer-masthead"');
		expect(result).toContain('className="atlas-footer-copy"');
		expect(result).toContain("Acme");
		expect(result).toContain("Powered by Jolli");
	});

	it("escapes HTML in the masthead siteName", () => {
		const result = buildAtlasFooterBody("Acme & <Co>");
		expect(result).not.toContain("Acme & <Co>");
		expect(result).toContain("&amp;");
		expect(result).toContain("&lt;");
	});

	it("uses customer copyright (with · Powered by Jolli suffix) when set", () => {
		const result = buildAtlasFooterBody("Acme", { copyright: "© 2026 Acme" });
		expect(result).toContain("© 2026 Acme · Powered by Jolli");
	});

	it("emits the full atlas-footer scaffold when footerConfig is configured", () => {
		const config: FooterConfig = {
			copyright: "© Acme",
			columns: [{ title: "Z", links: [{ label: "Q", url: "/q" }] }],
			socialLinks: { github: "https://gh.example" },
		};
		const result = buildAtlasFooterBody("Acme", config);
		expect(result).toContain('className="atlas-footer"');
		expect(result).toContain('className="atlas-footer-bottom"');
		expect(result).toContain('className="atlas-footer-columns"');
		expect(result).toContain('className="atlas-footer-social"');
		expect(result).toContain('className="atlas-footer-masthead"');
	});

	it("escapes HTML in customer-supplied copyright", () => {
		const result = buildAtlasFooterBody("X", { copyright: '<img src=x onerror="alert(1)">' });
		expect(result).not.toContain("<img");
		expect(result).toContain("&lt;img");
	});

	it("does not render a Powered-by-Jolli row separately (atlas folds it into the masthead copy)", () => {
		const result = buildAtlasFooterBody("Acme", { columns: [] });
		expect(result.match(/Powered by Jolli/g)?.length).toBe(1);
	});
});
