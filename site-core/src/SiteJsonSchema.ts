/**
 * SiteJsonSchema (pure half).
 *
 * `DEFAULT_SITE_JSON` plus the deprecated-alias coercions
 * (`branding.* → theme.*`, `footer.social → footer.socialLinks`,
 * `footer.socialLinks.x → footer.socialLinks.twitter`). All take a parsed
 * `SiteJson` and mutate it in place — no file I/O. The file-reading
 * wrapper (`readSiteJson`, prompt-driven first-time setup, docusaurus
 * conversion glue) lives in `cli/src/site/SiteJsonReader.ts`.
 */

import type { SiteJson } from "./Types.js";

export const DEFAULT_SITE_JSON: SiteJson = {
	title: "My Documentation Site",
	description: "A documentation site powered by Jolli",
	nav: [],
	theme: { pack: "forge" },
};

/**
 * Migrates the deprecated `branding.*` block into the canonical `theme.*`
 * block so downstream code only ever reads `theme`. `theme.*` wins when
 * both are set — a single-field override on top of a `branding` block keeps
 * working without forcing the customer to rewrite the whole block.
 *
 * Mapping (every field is optional):
 *   - `branding.themePack`           → `theme.pack`
 *   - `branding.colors.primaryHue`   → `theme.primaryHue`
 *   - `branding.fontFamily`          → `theme.fontFamily`
 *   - `branding.defaultTheme`        → `theme.defaultTheme`
 *   - `branding.favicon`             → `theme.favicon`
 *   - `branding.logo.image`          → `theme.logoUrl`
 *   - `branding.logo.imageDark`      → `theme.logoUrlDark`
 *   - `branding.logo.text`           → `theme.logoText`
 *   - `branding.logo.display`        → `theme.logoDisplay`
 *
 * `branding.logo.alt` is intentionally dropped — the CLI renderer derives
 * `<img alt>` from the title/logoText, and there's no plumbed-through
 * customization point for an explicit alt string yet.
 *
 * Mutates `config.theme` in place. Leaves `config.branding` intact so a
 * follow-up reader can inspect it for diagnostics — downstream code should
 * not read `branding` directly.
 */
export function coerceBrandingToTheme(config: SiteJson): void {
	const branding = config.branding;
	if (!branding) return;

	const existing = config.theme ?? {};
	const merged = { ...existing };

	if (branding.themePack !== undefined && merged.pack === undefined) {
		merged.pack = branding.themePack;
	}
	if (branding.favicon !== undefined && merged.favicon === undefined) {
		merged.favicon = branding.favicon;
	}
	if (branding.fontFamily !== undefined && merged.fontFamily === undefined) {
		merged.fontFamily = branding.fontFamily;
	}
	if (branding.defaultTheme !== undefined && merged.defaultTheme === undefined) {
		merged.defaultTheme = branding.defaultTheme;
	}
	if (branding.colors?.primaryHue !== undefined && merged.primaryHue === undefined) {
		merged.primaryHue = branding.colors.primaryHue;
	}
	if (branding.logo) {
		if (branding.logo.image !== undefined && merged.logoUrl === undefined) {
			merged.logoUrl = branding.logo.image;
		}
		if (branding.logo.imageDark !== undefined && merged.logoUrlDark === undefined) {
			merged.logoUrlDark = branding.logo.imageDark;
		}
		if (branding.logo.text !== undefined && merged.logoText === undefined) {
			merged.logoText = branding.logo.text;
		}
		if (branding.logo.display !== undefined && merged.logoDisplay === undefined) {
			merged.logoDisplay = branding.logo.display;
		}
	}

	config.theme = merged;
}

/**
 * Migrates the deprecated `footer.social` field into the canonical
 * `footer.socialLinks`. `socialLinks` wins if both are set.
 */
export function coerceFooterSocialAlias(config: SiteJson): void {
	if (!config.footer) return;
	if (config.footer.social && !config.footer.socialLinks) {
		config.footer.socialLinks = config.footer.social;
	}
}

/**
 * Copies `footer.socialLinks.x` into `footer.socialLinks.twitter` when
 * `twitter` is not already set. This lets site.json authors use `"x"` as
 * a modern alias for the Twitter/X platform link.
 */
export function coerceFooterXAlias(config: SiteJson): void {
	const links = config.footer?.socialLinks;
	if (!links) return;
	if (links.x && !links.twitter) {
		links.twitter = links.x;
	}
}

/**
 * Applies every deprecated-schema alias coercion in one pass. Convenient
 * for consumers that just want a normalized `SiteJson` without invoking
 * each migration individually.
 */
export function applyDeprecatedSchemaAliases(config: SiteJson): void {
	coerceBrandingToTheme(config);
	coerceFooterSocialAlias(config);
	coerceFooterXAlias(config);
}
