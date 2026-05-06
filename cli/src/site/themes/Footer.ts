/**
 * Footer.ts — semantic-class footer body builder shared by Forge / Atlas.
 *
 * Ported from the SaaS `tools/nextra-generator/src/themes/Shared.ts`
 * post-1392. URL / HTML escaping is delegated to the consolidated
 * `Sanitize.ts` module so all CLI surfaces share one allow-list.
 *
 * The pack stylesheets in `themes/{forge,atlas}/Css.ts` target a fixed set
 * of class names — `.{prefix}-footer`, `.{prefix}-footer-columns`,
 * `.{prefix}-footer-col`, `.{prefix}-footer-bottom`, `.{prefix}-footer-copyright`,
 * `.{prefix}-footer-social`, `.{prefix}-footer-powered`. Emitting matching
 * JSX is what makes the footer look right; without it the pack CSS targets
 * nothing and the layout collapses to default flex spacing with the wrong
 * typography.
 *
 * Helpers return JSX strings (not React nodes) because they're spliced
 * into a layout `app/layout.tsx` template at generation time; the customer
 * Next.js build is what eventually compiles them.
 */

import { escapeHtml, sanitizeUrl } from "../Sanitize.js";
import type { FooterConfig, SocialLinks } from "../Types.js";

/** Social platforms recognised by the footer renderer (in display order). */
export const SOCIAL_PLATFORMS = ["github", "twitter", "discord", "linkedin", "youtube"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** Human-readable labels used for `aria-label` on social-icon links. */
export const SOCIAL_LABELS: Record<SocialPlatform, string> = {
	github: "GitHub",
	twitter: "Twitter",
	discord: "Discord",
	linkedin: "LinkedIn",
	youtube: "YouTube",
};

// ─── renderFooterColumns ─────────────────────────────────────────────────────

/**
 * Render a footer's columns row. Returns "" when there are no columns —
 * callers can `if (cols)` to decide whether to wrap it.
 */
export function renderFooterColumns(footerConfig: FooterConfig, classPrefix: string): string {
	if (!footerConfig.columns || footerConfig.columns.length === 0) {
		return "";
	}
	const cols = footerConfig.columns
		.map((col) => {
			const links = col.links
				.map((link) => `<li><a href="${escapeHtml(sanitizeUrl(link.url))}">${escapeHtml(link.label)}</a></li>`)
				.join("");
			return `<div className="${classPrefix}-footer-col"><h4>${escapeHtml(col.title)}</h4><ul>${links}</ul></div>`;
		})
		.join("");
	return `<div className="${classPrefix}-footer-columns">${cols}</div>`;
}

// ─── renderSocialLinks ───────────────────────────────────────────────────────

/**
 * Render the social-icon link row. Returns "" when no platforms are set.
 */
export function renderSocialLinks(socialLinks: SocialLinks | undefined, classPrefix: string): string {
	if (!socialLinks) {
		return "";
	}
	const links = SOCIAL_PLATFORMS.filter((platform) => socialLinks[platform])
		.map((platform) => {
			const url = escapeHtml(sanitizeUrl(socialLinks[platform] as string));
			const label = SOCIAL_LABELS[platform];
			return `<a href="${url}" aria-label="${label}" className="${classPrefix}-footer-social-${platform}">${label}</a>`;
		})
		.join("");
	if (!links) {
		return "";
	}
	return `<div className="${classPrefix}-footer-social">${links}</div>`;
}

// ─── buildFooterScaffold ─────────────────────────────────────────────────────

/**
 * Wraps a pack's bottom-row content in the standard footer scaffold:
 *
 *   <div className="{prefix}-footer">
 *     {columnsJsx if any}
 *     <div className="{prefix}-footer-bottom">
 *       {bottom rows, in order}
 *     </div>
 *   </div>
 *
 * Each pack's bottom row differs (Forge: copyright + social + branding;
 * Atlas: masthead + social), so the rows themselves are passed in. Empty
 * strings are filtered so callers can pass `socialJsx` unconditionally.
 */
export function buildFooterScaffold(classPrefix: string, columnsJsx: string, bottomRows: Array<string>): string {
	const filteredBottom = bottomRows.filter(Boolean);
	const blocks: string[] = [`<div className="${classPrefix}-footer">`];
	if (columnsJsx) {
		blocks.push(`  ${columnsJsx}`);
	}
	blocks.push(`  <div className="${classPrefix}-footer-bottom">`);
	for (const row of filteredBottom) {
		blocks.push(`    ${row}`);
	}
	blocks.push(`  </div>`);
	blocks.push(`</div>`);
	return blocks.join("\n          ");
}

// ─── buildForgeFooterBody ────────────────────────────────────────────────────

/**
 * Build the inner JSX of `<Footer>` for the Forge pack. When `footerConfig`
 * is unset, falls back to a simple "year © siteName" line. When set,
 * renders a columns row + a bottom row with copyright, social-icon links,
 * and the "Powered by Jolli" branding.
 */
export function buildForgeFooterBody(siteName: string, footerConfig?: FooterConfig): string {
	const escapedName = escapeHtml(siteName);
	if (!footerConfig) {
		return `{new Date().getFullYear()} © ${escapedName} · Powered by Jolli`;
	}

	const copyright = footerConfig.copyright
		? `<span className="forge-footer-copyright">${escapeHtml(footerConfig.copyright)}</span>`
		: `<span className="forge-footer-copyright">{new Date().getFullYear()} © ${escapedName}</span>`;

	return buildFooterScaffold("forge", renderFooterColumns(footerConfig, "forge"), [
		copyright,
		renderSocialLinks(footerConfig.socialLinks, "forge"),
		`<span className="forge-footer-powered">Powered by Jolli</span>`,
	]);
}

// ─── buildAtlasFooterBody ────────────────────────────────────────────────────

/**
 * Build the inner JSX of `<Footer>` for the Atlas pack. Atlas leans on a
 * masthead-style bottom row (large site-name display + small copy line)
 * and adds the columns + social row above when `footerConfig` is set.
 */
export function buildAtlasFooterBody(siteName: string, footerConfig?: FooterConfig): string {
	const escapedName = escapeHtml(siteName);

	const masthead = [
		`<div className="atlas-footer-masthead">${escapedName}</div>`,
		footerConfig?.copyright
			? `<div className="atlas-footer-copy">${escapeHtml(footerConfig.copyright)} · Powered by Jolli</div>`
			: `<div className="atlas-footer-copy">{new Date().getFullYear()} · Powered by Jolli</div>`,
	].join("");

	if (!footerConfig) {
		return `<div>${masthead}</div>`;
	}

	return buildFooterScaffold("atlas", renderFooterColumns(footerConfig, "atlas"), [
		`<div>${masthead}</div>`,
		renderSocialLinks(footerConfig.socialLinks, "atlas"),
	]);
}
