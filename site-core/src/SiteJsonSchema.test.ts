import { describe, expect, it } from "vitest";
import {
	applyDeprecatedSchemaAliases,
	coerceBrandingToTheme,
	coerceFooterSocialAlias,
	coerceFooterXAlias,
	DEFAULT_SITE_JSON,
} from "./SiteJsonSchema.js";
import type { SiteJson } from "./Types.js";

function makeConfig(overrides: Partial<SiteJson> = {}): SiteJson {
	return { title: "Test", description: "Test description", nav: [], ...overrides };
}

describe("DEFAULT_SITE_JSON", () => {
	it("ships forge as the default theme pack and an empty nav", () => {
		expect(DEFAULT_SITE_JSON.theme?.pack).toBe("forge");
		expect(DEFAULT_SITE_JSON.nav).toEqual([]);
		expect(DEFAULT_SITE_JSON.title).toMatch(/Documentation/i);
	});
});

describe("coerceBrandingToTheme", () => {
	it("returns silently when branding is absent", () => {
		const config = makeConfig();
		coerceBrandingToTheme(config);
		expect(config.theme).toBeUndefined();
	});

	it("maps every documented field with `theme` winning when both are set", () => {
		const config = makeConfig({
			theme: { pack: "atlas" }, // theme.pack already set — should win
			branding: {
				themePack: "forge", // ignored because theme.pack is set
				favicon: "/fav.ico",
				fontFamily: "inter",
				defaultTheme: "dark",
				colors: { primaryHue: 240 },
				logo: {
					image: "/logo.svg",
					imageDark: "/logo-dark.svg",
					text: "ACME",
					display: "both",
				},
			},
		});
		coerceBrandingToTheme(config);
		expect(config.theme).toEqual({
			pack: "atlas", // unchanged
			favicon: "/fav.ico",
			fontFamily: "inter",
			defaultTheme: "dark",
			primaryHue: 240,
			logoUrl: "/logo.svg",
			logoUrlDark: "/logo-dark.svg",
			logoText: "ACME",
			logoDisplay: "both",
		});
		// branding stays intact for follow-up inspection
		expect(config.branding?.themePack).toBe("forge");
	});

	it("creates a theme block from scratch when only branding is present", () => {
		const config = makeConfig({
			branding: { themePack: "atlas" },
		});
		coerceBrandingToTheme(config);
		expect(config.theme).toEqual({ pack: "atlas" });
	});
});

describe("coerceFooterSocialAlias", () => {
	it("promotes footer.social into footer.socialLinks when socialLinks is missing", () => {
		const config = makeConfig({ footer: { social: { github: "https://github.com/x" } } });
		coerceFooterSocialAlias(config);
		expect(config.footer?.socialLinks).toEqual({ github: "https://github.com/x" });
	});

	it("leaves socialLinks alone when both are set (socialLinks wins)", () => {
		const config = makeConfig({
			footer: {
				social: { github: "old" },
				socialLinks: { github: "new" },
			},
		});
		coerceFooterSocialAlias(config);
		expect(config.footer?.socialLinks).toEqual({ github: "new" });
	});

	it("is a no-op when footer is missing", () => {
		const config = makeConfig();
		coerceFooterSocialAlias(config);
		expect(config.footer).toBeUndefined();
	});
});

describe("coerceFooterXAlias", () => {
	it("copies socialLinks.x into socialLinks.twitter when twitter is empty", () => {
		const config = makeConfig({ footer: { socialLinks: { x: "https://x.com/acme" } } });
		coerceFooterXAlias(config);
		expect(config.footer?.socialLinks?.twitter).toBe("https://x.com/acme");
	});

	it("does not override an explicit twitter setting", () => {
		const config = makeConfig({
			footer: { socialLinks: { x: "from-x", twitter: "explicit-twitter" } },
		});
		coerceFooterXAlias(config);
		expect(config.footer?.socialLinks?.twitter).toBe("explicit-twitter");
	});

	it("is a no-op when socialLinks is missing", () => {
		const config = makeConfig({ footer: {} });
		coerceFooterXAlias(config);
		expect(config.footer?.socialLinks).toBeUndefined();
	});
});

describe("applyDeprecatedSchemaAliases", () => {
	it("runs all three coercions in one pass", () => {
		const config = makeConfig({
			branding: { themePack: "forge" },
			footer: { social: { x: "https://x.com/a" } },
		});
		applyDeprecatedSchemaAliases(config);
		expect(config.theme?.pack).toBe("forge");
		expect(config.footer?.socialLinks?.x).toBe("https://x.com/a");
		expect(config.footer?.socialLinks?.twitter).toBe("https://x.com/a");
	});
});

describe("coerceBrandingToTheme (logo paths)", () => {
	it("respects existing theme.logoUrl / logoUrlDark / logoText / logoDisplay over branding.logo.*", () => {
		const config = makeConfig({
			theme: { logoUrl: "explicit", logoUrlDark: "explicit-dark", logoText: "ACME", logoDisplay: "text" },
			branding: {
				logo: { image: "from-branding", imageDark: "from-branding-dark", text: "ABC", display: "image" },
			},
		});
		coerceBrandingToTheme(config);
		expect(config.theme).toEqual({
			logoUrl: "explicit",
			logoUrlDark: "explicit-dark",
			logoText: "ACME",
			logoDisplay: "text",
		});
	});

	it("ignores branding.logo when logo is undefined (branching guard)", () => {
		const config = makeConfig({ branding: { themePack: "atlas" } });
		coerceBrandingToTheme(config);
		// Should not crash, no logo fields populated.
		expect(config.theme).toEqual({ pack: "atlas" });
	});
});
