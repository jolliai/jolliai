/**
 * Atlas layout generator — produces `app/layout.tsx` for sites that pick
 * `theme.pack === "atlas"` in their `site.json`.
 *
 * Adapted from the SaaS Atlas layout
 * (`tools/nextra-generator/src/themes/atlas/templates/Layout.ts` in
 * jolli.ai/jolli) post-JOLLI-1392, with the same SaaS-only bits stripped
 * as the Forge port (`ScopedNextraLayout`, auth banner, auth provider,
 * `filterAuthFromPageMap`).
 *
 * Atlas differs from Forge layout-wise in a handful of places:
 *   - logo lives only in the navbar (`.atlas-navbar-logo`) — no separate
 *     sidebar logo wrapper
 *   - no sidebar search block — Atlas uses Nextra's default navbar search
 *   - `<Head color={{ saturation: 70 }}>` (vs Forge's 84)
 *   - passes `toc={{ title: 'Contents' }}` to `<Layout>` so the TOC label
 *     reads in Atlas's editorial voice
 *
 * Customer fields resolved from `theme.*` (with Atlas manifest defaults):
 *   - `primaryHue`         → `<Head color={{ hue, saturation: 70 }}>`
 *   - `defaultTheme`       → `<Layout nextThemes={{ defaultTheme }}>`
 *                            (defaults to "dark")
 *   - `fontFamily`         → Google Fonts `<link>` + `--atlas-font-family`
 *                            (defaults to "source-serif")
 *   - `logoUrl`/`Dark`     → `<img>` rendered in the navbar logo slot
 *   - `favicon`            → `<link rel="icon">` (top-level `favicon` wins)
 */

import type {
	DefaultThemeMode,
	ExternalLink,
	FontFamily,
	FooterConfig,
	HeaderConfig,
	HeaderItem,
	NavLink,
} from "../../Types.js";
import { ATLAS_MANIFEST } from "./Manifest.js";

// ─── Font config ─────────────────────────────────────────────────────────────

interface FontEntry {
	url: string;
	cssFamily: string;
}

/**
 * Google Fonts URLs + CSS family values. Same shape as Forge's `FONT_CONFIG`
 * (mirrors `FONT_CONFIG` from jolli-common). Duplicated here rather than
 * factored out — sharing is a 30-line refactor for marginal value when
 * there are only two packs; revisit if a third pack lands.
 */
const FONT_CONFIG: Record<FontFamily, FontEntry> = {
	inter: {
		url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
		cssFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
	},
	"space-grotesk": {
		url: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
		cssFamily: "'Space Grotesk', -apple-system, sans-serif",
	},
	"ibm-plex": {
		url: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap",
		cssFamily: "'IBM Plex Sans', -apple-system, sans-serif",
	},
	"source-sans": {
		url: "https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&display=swap",
		cssFamily: "'Source Sans 3', -apple-system, sans-serif",
	},
	"source-serif": {
		url: "https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600;8..60,700&display=swap",
		cssFamily: "'Source Serif 4', 'Iowan Old Style', Georgia, serif",
	},
};

// ─── AtlasLayoutInput ────────────────────────────────────────────────────────

export interface AtlasLayoutInput {
	title: string;
	description: string;
	nav: NavLink[];
	header?: HeaderConfig;
	footer?: FooterConfig;
	primaryHue: number;
	defaultTheme: DefaultThemeMode;
	fontFamily: FontFamily;
	logoUrl?: string;
	logoUrlDark?: string;
	favicon?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** See `themes/forge/Layout.ts` — same allow-list, same fail-closed default. */
function sanitizeUrl(url: string): string {
	const trimmed = url.trim();
	if (trimmed === "" || /^(?:https?:|mailto:|tel:|[#?/]|\.\.?\/)/i.test(trimmed)) {
		return trimmed;
	}
	return "#";
}

/**
 * Logo slot markup for the Atlas navbar. JSX-expression attributes
 * (`src={...}`, `alt={...}`) keep user-controlled title out of raw HTML
 * attributes. Atlas only renders the logo in the navbar — there's no
 * sidebar logo wrapper to populate.
 *
 * Returns `{ light, dark }`:
 *   - No `logoUrl`             → both empty (text-only logo)
 *   - `logoUrl` only           → single `<img>`, no dark swap
 *   - `logoUrl` + `logoUrlDark` → paired imgs with `.atlas-logo-light` /
 *                                 `.atlas-logo-dark`
 */
function buildLogoSlots(input: AtlasLayoutInput): { light: string; dark: string } {
	if (!input.logoUrl) {
		return { light: "", dark: "" };
	}
	const jsAlt = JSON.stringify(input.title);
	const jsLightSrc = JSON.stringify(sanitizeUrl(input.logoUrl));
	if (!input.logoUrlDark) {
		return { light: `<img src={${jsLightSrc}} alt={${jsAlt}} />`, dark: "" };
	}
	const jsDarkSrc = JSON.stringify(sanitizeUrl(input.logoUrlDark));
	return {
		light: `<img src={${jsLightSrc}} alt={${jsAlt}} className="atlas-logo-light" />`,
		dark: `<img src={${jsDarkSrc}} alt={${jsAlt}} className="atlas-logo-dark" />`,
	};
}

/**
 * Resolves the navbar's logical item list. `header.items` wins when set;
 * otherwise legacy `nav` is coerced into dropdown-less items.
 */
function resolveHeaderItems(input: AtlasLayoutInput): HeaderItem[] {
	if (input.header?.items && input.header.items.length > 0) {
		return input.header.items;
	}
	return input.nav.map((n) => ({ label: n.label, url: n.href }));
}

/** Renders a single header item — either an `<a>` or a `<details>` dropdown. */
function renderNavbarChild(item: HeaderItem): string {
	const jsLabel = JSON.stringify(item.label);
	if (item.items && item.items.length > 0) {
		const subLinks = item.items
			.map((sub: ExternalLink) => {
				const jsSubLabel = JSON.stringify(sub.label);
				const jsSubHref = JSON.stringify(sanitizeUrl(sub.url));
				return `              <a href={${jsSubHref}} style={{ display: 'block', padding: '0.25rem 0.75rem', whiteSpace: 'nowrap' }}>{${jsSubLabel}}</a>`;
			})
			.join("\n");
		return [
			`          <details style={{ marginLeft: '1rem', display: 'inline-block', position: 'relative' }}>`,
			`            <summary style={{ cursor: 'pointer', listStyle: 'none' }}>{${jsLabel}}</summary>`,
			`            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: '0.25rem', background: 'var(--nextra-bg, #fff)', border: '1px solid var(--nextra-border, #e5e7eb)', borderRadius: 4, padding: '0.25rem 0', minWidth: 160, zIndex: 10 }}>`,
			subLinks,
			`            </div>`,
			`          </details>`,
		].join("\n");
	}
	const jsHref = JSON.stringify(sanitizeUrl(item.url ?? "#"));
	return `          <a href={${jsHref}} style={{ marginLeft: '1rem' }}>{${jsLabel}}</a>`;
}

/** Social platforms supported in the footer, in display order. */
const SOCIAL_PLATFORMS = ["github", "twitter", "discord", "linkedin", "youtube"] as const;

/** Builds the inner JSX of `<Footer>`, or `""` when there's nothing to render. */
function buildFooterBody(footer: FooterConfig | undefined): string {
	if (!footer) return "";

	const hasColumns = footer.columns && footer.columns.length > 0;
	const hasCopyright = typeof footer.copyright === "string" && footer.copyright.length > 0;
	const socials = footer.socialLinks;
	const socialEntries = socials
		? SOCIAL_PLATFORMS.filter((p) => typeof socials[p] === "string" && socials[p] !== "")
		: [];
	const hasSocial = socialEntries.length > 0;

	if (!hasColumns && !hasCopyright && !hasSocial) return "";

	const blocks: string[] = [];

	if (hasColumns) {
		const columnsJsx = (footer.columns ?? [])
			.map((col) => {
				const jsTitle = JSON.stringify(col.title);
				const links = col.links
					.map((link: ExternalLink) => {
						const jsLabel = JSON.stringify(link.label);
						const jsHref = JSON.stringify(sanitizeUrl(link.url));
						return `                <li><a href={${jsHref}}>{${jsLabel}}</a></li>`;
					})
					.join("\n");
				return [
					`            <div style={{ minWidth: 140 }}>`,
					`              <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', fontWeight: 600 }}>{${jsTitle}}</h4>`,
					`              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>`,
					links,
					`              </ul>`,
					`            </div>`,
				].join("\n");
			})
			.join("\n");
		blocks.push(
			`          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1rem' }}>\n${columnsJsx}\n          </div>`,
		);
	}

	if (hasCopyright || hasSocial) {
		const bottom: string[] = [];
		if (hasCopyright) {
			const jsCopyright = JSON.stringify(footer.copyright);
			bottom.push(`            <span>{${jsCopyright}}</span>`);
		}
		if (hasSocial && socials) {
			const social = socialEntries
				.map((p) => {
					const jsHref = JSON.stringify(sanitizeUrl(socials[p] ?? ""));
					const jsLabel = JSON.stringify(p);
					return `              <a href={${jsHref}} aria-label={${jsLabel}}>{${jsLabel}}</a>`;
				})
				.join("\n");
			bottom.push(`            <div style={{ display: 'flex', gap: '0.75rem' }}>\n${social}\n            </div>`);
		}
		blocks.push(
			`          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>\n${bottom.join("\n")}\n          </div>`,
		);
	}

	return [`        <div style={{ width: '100%' }}>`, ...blocks, `        </div>`].join("\n");
}

// ─── generateAtlasLayoutTsx ──────────────────────────────────────────────────

/**
 * Returns the full contents of `app/layout.tsx` for an Atlas-themed site.
 * Caller is responsible for writing `app/themes/atlas.css` (which this
 * layout imports) — see `initNextraProject` in `NextraProjectWriter`.
 */
export function generateAtlasLayoutTsx(input: AtlasLayoutInput): string {
	const jsTitle = JSON.stringify(input.title);
	const jsDescription = JSON.stringify(input.description);
	const jsDefaultTheme = JSON.stringify(input.defaultTheme);

	const font = FONT_CONFIG[input.fontFamily];
	const fontLink = `<link rel="stylesheet" href={${JSON.stringify(font.url)}} />`;
	const faviconLink = input.favicon ? `<link rel="icon" href={${JSON.stringify(sanitizeUrl(input.favicon))}} />` : "";

	const logo = buildLogoSlots(input);
	const logoMarkup = `${logo.light}${logo.dark}<span>{${jsTitle}}</span>`;

	const headerItems = resolveHeaderItems(input);
	const navLinks = headerItems.map(renderNavbarChild).join("\n");
	const navbarChildren = headerItems.length > 0 ? `\n${navLinks}\n        ` : "";

	const footerBody = buildFooterBody(input.footer);
	const footerJsx =
		footerBody === ""
			? `<Footer>{new Date().getFullYear()} © {${jsTitle}}</Footer>`
			: `<Footer>\n${footerBody}\n      </Footer>`;

	return `import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'
import '../styles/api.css'
import './themes/atlas.css'

export const metadata = {
  title: ${jsTitle},
  description: ${jsDescription},
}

const SiteLogo = () => (
  <span className="atlas-navbar-logo">
    ${logoMarkup}
  </span>
)

const navbar = <Navbar logo={<SiteLogo />}>${navbarChildren}</Navbar>
const footer = ${footerJsx}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head color={{ hue: ${input.primaryHue}, saturation: 70 }}>
        ${fontLink}
        ${faviconLink}
      </Head>
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          footer={footer}
          editLink={null}
          feedback={{ content: null }}
          toc={{ title: 'Contents' }}
          darkMode={true}
          nextThemes={{ defaultTheme: ${jsDefaultTheme} }}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
`;
}

// ─── resolveAtlasLayoutInput ─────────────────────────────────────────────────

/**
 * Resolves the `AtlasLayoutInput` from a project config + `theme` block,
 * applying Atlas manifest defaults for any unset customer field. Same
 * legacy-favicon precedence rule as Forge: top-level `favicon` wins over
 * `theme.favicon`.
 */
export function resolveAtlasLayoutInput(args: {
	title: string;
	description: string;
	nav: NavLink[];
	header?: HeaderConfig;
	footer?: FooterConfig;
	theme:
		| {
				primaryHue?: number;
				defaultTheme?: DefaultThemeMode;
				fontFamily?: FontFamily;
				logoUrl?: string;
				logoUrlDark?: string;
				favicon?: string;
		  }
		| undefined;
	legacyFavicon: string | undefined;
}): AtlasLayoutInput {
	const t = args.theme ?? {};
	return {
		title: args.title,
		description: args.description,
		nav: args.nav,
		header: args.header,
		footer: args.footer,
		primaryHue: t.primaryHue ?? ATLAS_MANIFEST.defaults.primaryHue,
		defaultTheme: t.defaultTheme ?? ATLAS_MANIFEST.defaults.defaultTheme,
		fontFamily: t.fontFamily ?? ATLAS_MANIFEST.defaults.fontFamily,
		logoUrl: t.logoUrl,
		logoUrlDark: t.logoUrlDark,
		favicon: args.legacyFavicon ?? t.favicon,
	};
}

// ─── buildAtlasFontFamilyCssValue ────────────────────────────────────────────

/**
 * Resolves the CSS `font-family` value for a given `FontFamily` choice.
 * Used by `NextraProjectWriter` to pass into `buildAtlasCss({ fontFamily })`
 * so the generated CSS overrides match the `<link>`-loaded Google Font.
 */
export function buildAtlasFontFamilyCssValue(font: FontFamily): string {
	return FONT_CONFIG[font].cssFamily;
}
