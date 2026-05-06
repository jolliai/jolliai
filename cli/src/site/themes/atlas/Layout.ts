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

import { sanitizeUrl } from "../../Sanitize.js";
import type { DefaultThemeMode, FontFamily, FooterConfig, HeaderConfig, LogoDisplay } from "../../Types.js";
import { buildAtlasFooterBody } from "../Footer.js";
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
	header?: HeaderConfig;
	footer?: FooterConfig;
	primaryHue: number;
	defaultTheme: DefaultThemeMode;
	fontFamily: FontFamily;
	logoUrl?: string;
	logoUrlDark?: string;
	/** Optional override for the text shown alongside (or instead of) the logo image. Falls back to `title`. */
	logoText?: string;
	/** Override for the logo composition mode. See `LogoDisplay` in `Types.ts` for the auto-default rules. */
	logoDisplay?: LogoDisplay;
	favicon?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
 * Resolves the effective `LogoDisplay` mode. See the matching helper in
 * `themes/forge/Layout.ts` for the rules.
 */
function resolveLogoDisplay(input: AtlasLayoutInput): LogoDisplay {
	if (input.logoDisplay === "image" && !input.logoUrl) return "text";
	if (input.logoDisplay) return input.logoDisplay;
	return input.logoUrl ? "both" : "text";
}

/**
 * Composes the navbar logo markup from light/dark image slots and a text
 * template. `textTemplate` is a JSX snippet with the literal token `TEXT`
 * where the logo text expression should be spliced.
 */
function composeLogoMarkup(
	input: AtlasLayoutInput,
	logoSlots: { light: string; dark: string },
	textTemplate: string,
): string {
	const display = resolveLogoDisplay(input);
	const logoText = input.logoText ?? input.title;
	const textMarkup = textTemplate.replace("TEXT", JSON.stringify(logoText));
	const imageMarkup = `${logoSlots.light}${logoSlots.dark}`;
	switch (display) {
		case "image":
			return imageMarkup;
		case "text":
			return textMarkup;
		default:
			return `${imageMarkup}${textMarkup}`;
	}
}

// ─── generateAtlasLayoutTsx ──────────────────────────────────────────────────

/**
 * Returns the full contents of `app/layout.tsx` for an Atlas-themed site.
 * Caller is responsible for writing `app/themes/atlas.css` (which this
 * layout imports) and `components/ScopedNextraLayout.tsx` (which this
 * layout imports) — see `initNextraProject` in `NextraProjectWriter`.
 *
 * Mirrors the SaaS Atlas layout post-1392: navbar has only a logo
 * (no children) — page tabs come from the root `_meta.js`. Sidebar
 * scoping is handled by `<ScopedNextraLayout>` based on the URL.
 */
export function generateAtlasLayoutTsx(input: AtlasLayoutInput): string {
	const jsTitle = JSON.stringify(input.title);
	const jsDescription = JSON.stringify(input.description);
	const jsDefaultTheme = JSON.stringify(input.defaultTheme);

	const font = FONT_CONFIG[input.fontFamily];
	const fontLink = `<link rel="stylesheet" href={${JSON.stringify(font.url)}} />`;
	const faviconLink = input.favicon ? `<link rel="icon" href={${JSON.stringify(sanitizeUrl(input.favicon))}} />` : "";

	const logo = buildLogoSlots(input);
	const logoMarkup = composeLogoMarkup(input, logo, "<span>{TEXT}</span>");

	const footerBody = buildAtlasFooterBody(input.title, input.footer);
	const footerJsx = `<Footer>${footerBody}</Footer>`;

	return `import { Footer, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'
import '../styles/api.css'
import './themes/atlas.css'
import ScopedNextraLayout from '../components/ScopedNextraLayout'

export const metadata = {
  title: ${jsTitle},
  description: ${jsDescription},
}

const SiteLogo = () => (
  <span className="atlas-navbar-logo">
    ${logoMarkup}
  </span>
)

const navbar = <Navbar logo={<SiteLogo />} />
const footer = ${footerJsx}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head color={{ hue: ${input.primaryHue}, saturation: 70 }}>
        ${fontLink}
        ${faviconLink}
      </Head>
      <body>
        <ScopedNextraLayout
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
        </ScopedNextraLayout>
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
	header?: HeaderConfig;
	footer?: FooterConfig;
	theme:
		| {
				primaryHue?: number;
				defaultTheme?: DefaultThemeMode;
				fontFamily?: FontFamily;
				logoUrl?: string;
				logoUrlDark?: string;
				logoText?: string;
				logoDisplay?: LogoDisplay;
				favicon?: string;
		  }
		| undefined;
	legacyFavicon: string | undefined;
}): AtlasLayoutInput {
	const t = args.theme ?? {};
	return {
		title: args.title,
		description: args.description,
		header: args.header,
		footer: args.footer,
		primaryHue: t.primaryHue ?? ATLAS_MANIFEST.defaults.primaryHue,
		defaultTheme: t.defaultTheme ?? ATLAS_MANIFEST.defaults.defaultTheme,
		fontFamily: t.fontFamily ?? ATLAS_MANIFEST.defaults.fontFamily,
		logoUrl: t.logoUrl,
		logoUrlDark: t.logoUrlDark,
		logoText: t.logoText,
		logoDisplay: t.logoDisplay,
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
