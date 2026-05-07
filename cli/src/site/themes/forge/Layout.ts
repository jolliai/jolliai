/**
 * Forge layout generator — produces `app/layout.tsx` for sites that pick
 * `theme.pack === "forge"` in their `site.json`.
 *
 * Adapted from the SaaS Forge layout
 * (`tools/nextra-generator/src/themes/forge/templates/Layout.ts` in
 * jolli.ai/jolli) post-JOLLI-1392, with the SaaS-only bits stripped:
 *
 *   - `ScopedNextraLayout` → vanilla `<Layout>` from `nextra-theme-docs`
 *   - `<AuthBanner>` / `<Auth0Provider>` slots removed (CLI sites are
 *     not multi-tenant and don't gate on JWT auth)
 *   - `filterAuthFromPageMap` removed (no `/auth` callback page)
 *
 * The Forge-specific wrapper elements (`.forge-sidebar-logo`,
 * `.forge-sidebar-search`, `.forge-navbar-logo`) are preserved verbatim
 * because Css.ts targets them.
 *
 * Customer fields resolved from `theme.*` (with Forge manifest defaults):
 *   - `primaryHue`         → `<Head color={{ hue, saturation: 84 }}>`
 *   - `defaultTheme`       → `<Layout nextThemes={{ defaultTheme }}>`
 *   - `fontFamily`         → Google Fonts `<link>` + a CSS variable picked
 *                            up by Css.ts via `--forge-font-family`
 *   - `logoUrl`/`Dark`     → `<img>` tags rendered in both the navbar logo
 *                            slot and the sidebar logo wrapper
 *   - `favicon`            → `<link rel="icon">` (top-level `favicon` wins
 *                            for back-compat; `theme.favicon` is the fallback)
 */

import { sanitizeUrl } from "../../Sanitize.js";
import type { DefaultThemeMode, FontFamily, FooterConfig, HeaderConfig, LogoDisplay } from "../../Types.js";
import { buildForgeFooterBody } from "../Footer.js";
import { FORGE_MANIFEST } from "./Manifest.js";

// ─── Font config ─────────────────────────────────────────────────────────────

interface FontEntry {
	url: string;
	cssFamily: string;
}

/**
 * Google Fonts URLs + CSS family values. Mirrors `FONT_CONFIG` from
 * jolli-common so a single `theme.fontFamily` value renders identically in
 * both surfaces.
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

// ─── ForgeLayoutInput ────────────────────────────────────────────────────────

export interface ForgeLayoutInput {
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
 * Logo slot markup used in both the navbar logo + sidebar logo positions.
 * Each `<img>` uses JSX-expression attributes (`src={...}` / `alt={...}`)
 * stamped from JSON-stringified values, so the user-controlled title is
 * never spliced into a raw HTML attribute (no escape needed, no breakout
 * surface).
 *
 * Returns `{ light, dark }`:
 *   - No `logoUrl`            → both empty (text-only logo)
 *   - `logoUrl` only          → single light-mode `<img>`, no dark swap
 *   - `logoUrl` + `logoUrlDark` → paired imgs with `.forge-logo-light` /
 *                                 `.forge-logo-dark`; CSS swaps based on `.dark`
 */
function buildLogoSlots(input: ForgeLayoutInput): { light: string; dark: string } {
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
		light: `<img src={${jsLightSrc}} alt={${jsAlt}} className="forge-logo-light" />`,
		dark: `<img src={${jsDarkSrc}} alt={${jsAlt}} className="forge-logo-dark" />`,
	};
}

/**
 * Resolves the effective `LogoDisplay` mode for an input. When the customer
 * sets `logoDisplay` explicitly, that wins. Otherwise the legacy auto-default
 * applies — `"both"` if `logoUrl` is set, `"text"` otherwise — so existing
 * site.json files render unchanged.
 *
 * Special case: `display: "image"` with no `logoUrl` configured falls back to
 * `"text"`. Rendering an empty navbar logo would be a worse UX than honouring
 * the customer's intent partially.
 */
function resolveLogoDisplay(input: ForgeLayoutInput): LogoDisplay {
	if (input.logoDisplay === "image" && !input.logoUrl) return "text";
	if (input.logoDisplay) return input.logoDisplay;
	return input.logoUrl ? "both" : "text";
}

/**
 * Builds the inner markup for the logo slot. `textTemplate` is a JSX snippet
 * with the literal token `TEXT` where the logo text expression should be
 * spliced — Forge / Atlas / default each use different element wrappers, so
 * the caller passes the wrapper and this helper handles the composition.
 */
function composeLogoMarkup(
	input: ForgeLayoutInput,
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

// ─── generateForgeLayoutTsx ──────────────────────────────────────────────────

/**
 * Returns the full contents of `app/layout.tsx` for a Forge-themed site.
 * Caller is responsible for writing `app/themes/forge.css` (which this
 * layout imports) and `components/ScopedNextraLayout.tsx` (which this
 * layout imports) — see `initNextraProject` in `NextraProjectWriter`.
 *
 * Mirrors the SaaS Forge layout post-1392: navbar children reduced to
 * `<ThemeSwitch />` only — page tabs come from the root `_meta.js`
 * (Nextra renders them natively with chevron / hover / mobile drawer
 * styling). Sidebar scoping is handled by `<ScopedNextraLayout>` based
 * on the URL.
 */
export function generateForgeLayoutTsx(input: ForgeLayoutInput): string {
	const jsTitle = JSON.stringify(input.title);
	const jsDescription = JSON.stringify(input.description);
	const jsDefaultTheme = JSON.stringify(input.defaultTheme);

	const font = FONT_CONFIG[input.fontFamily];
	const fontLink = `<link rel="stylesheet" href={${JSON.stringify(font.url)}} />`;
	const faviconLink = input.favicon ? `<link rel="icon" href={${JSON.stringify(sanitizeUrl(input.favicon))}} />` : "";

	const logo = buildLogoSlots(input);
	const logoMarkup = composeLogoMarkup(input, logo, "<span>{TEXT}</span>");

	const footerBody = buildForgeFooterBody(input.title, input.footer);
	const footerJsx = `<Footer>${footerBody}</Footer>`;

	return `import { Footer, Navbar, ThemeSwitch } from 'nextra-theme-docs'
import { Head, Search } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'
import '../styles/api.css'
import './themes/forge.css'
import ScopedNextraLayout from '../components/ScopedNextraLayout'

export const metadata = {
  title: ${jsTitle},
  description: ${jsDescription},
}

const SiteLogo = () => (
  <span className="forge-navbar-logo">
    ${logoMarkup}
  </span>
)

const navbar = <Navbar logo={<SiteLogo />}><ThemeSwitch /></Navbar>
const footer = ${footerJsx}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head color={{ hue: ${input.primaryHue}, saturation: 84 }}>
        ${fontLink}
        ${faviconLink}
      </Head>
      <body>
        <div className="forge-sidebar-logo">
          <a href="/">
            ${logoMarkup}
          </a>
        </div>

        <div className="forge-sidebar-search">
          <Search placeholder="Search…" />
        </div>

        <ScopedNextraLayout
          navbar={navbar}
          pageMap={await getPageMap()}
          footer={footer}
          editLink={null}
          feedback={{ content: null }}
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

// ─── resolveForgeLayoutInput ─────────────────────────────────────────────────

/**
 * Resolves the `ForgeLayoutInput` from a project config + `theme` block,
 * applying Forge manifest defaults for any unset customer field.
 *
 * `favicon` lookup follows the deprecated-alias rule: top-level `favicon`
 * (passed in via `legacyFavicon`) wins when set; `theme.favicon` is the
 * fallback. Drops back to `undefined` when neither is configured — the
 * layout omits the `<link rel="icon">` tag in that case.
 */
export function resolveForgeLayoutInput(args: {
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
}): ForgeLayoutInput {
	const t = args.theme ?? {};
	return {
		title: args.title,
		description: args.description,
		header: args.header,
		footer: args.footer,
		primaryHue: t.primaryHue ?? FORGE_MANIFEST.defaults.primaryHue,
		defaultTheme: t.defaultTheme ?? FORGE_MANIFEST.defaults.defaultTheme,
		fontFamily: t.fontFamily ?? FORGE_MANIFEST.defaults.fontFamily,
		logoUrl: t.logoUrl,
		logoUrlDark: t.logoUrlDark,
		logoText: t.logoText,
		logoDisplay: t.logoDisplay,
		favicon: args.legacyFavicon ?? t.favicon,
	};
}

// ─── buildForgeFontFamilyCssValue ────────────────────────────────────────────

/**
 * Resolves the CSS `font-family` value for a given `FontFamily` choice.
 * Used by `NextraProjectWriter` to pass into `buildForgeCss({ fontFamily })`
 * so the generated CSS overrides match the `<link>`-loaded Google Font.
 */
export function buildForgeFontFamilyCssValue(font: FontFamily): string {
	return FONT_CONFIG[font].cssFamily;
}
