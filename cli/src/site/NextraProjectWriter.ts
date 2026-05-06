/**
 * NextraProjectWriter — writes and maintains the Nextra v4 project scaffold
 * inside `.jolli-site/`.
 *
 * Generates `package.json`, `next.config.mjs`, `app/layout.tsx`,
 * `mdx-components.tsx`, and `tsconfig.json` into the build directory. On
 * subsequent runs, regenerates these files with updated config values
 * (incremental update, not a full recreate).
 *
 * Nextra v4 requires the App Router — content lives in `content/` (not
 * `pages/`), and the theme is configured via component props in
 * `app/layout.tsx` rather than a standalone `theme.config.tsx`.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FooterConfig, HeaderConfig, HeaderItem, NavLink, ThemeConfig, ThemePack } from "./Types.js";
import {
	buildAtlasCss,
	buildAtlasFontFamilyCssValue,
	generateAtlasLayoutTsx,
	resolveAtlasLayoutInput,
} from "./themes/atlas/index.js";
import {
	buildForgeCss,
	buildForgeFontFamilyCssValue,
	generateForgeLayoutTsx,
	resolveForgeLayoutInput,
} from "./themes/forge/index.js";

// ─── NextraProjectConfig ──────────────────────────────────────────────────────

/**
 * Configuration derived from `site.json` that drives the generated Nextra
 * project files.
 */
export interface NextraProjectConfig {
	title: string;
	description: string;
	nav: NavLink[];
	header?: HeaderConfig;
	footer?: FooterConfig;
	/**
	 * Legacy top-level `favicon` URL. Deprecated alias for `theme.favicon`;
	 * when both are set the top-level value wins so existing sites keep
	 * working unchanged.
	 */
	favicon?: string;
	theme?: ThemeConfig;
}

// ─── initNextraProject ────────────────────────────────────────────────────────

/**
 * Initialises (or updates) the Nextra v4 project scaffold inside `buildDir`.
 *
 * - If `buildDir` does not exist: creates it, writes all config files, and
 *   returns `{ isNew: true }`.
 * - If `buildDir` already exists: regenerates the config files with the
 *   latest values from `config` and returns `{ isNew: false }`.
 *
 * In both cases the `content/` subdirectory is created (or left intact).
 */
export async function initNextraProject(
	buildDir: string,
	config: NextraProjectConfig,
	options: { staticExport?: boolean } = {},
): Promise<{ isNew: boolean }> {
	const isNew = !existsSync(buildDir);

	// Create the build directory and subdirectories if needed.
	await mkdir(join(buildDir, "content"), { recursive: true });
	await mkdir(join(buildDir, "app", "[[...mdxPath]]"), { recursive: true });

	// Always regenerate config files so they reflect the latest site.json values.
	await writeFile(join(buildDir, "package.json"), generatePackageJson(), "utf-8");
	await writeFile(join(buildDir, "next.config.mjs"), generateNextConfig(options.staticExport), "utf-8");
	await writeFile(join(buildDir, "app", "layout.tsx"), generateLayout(config), "utf-8");
	await writeFile(join(buildDir, "app", "not-found.tsx"), generateNotFound(), "utf-8");
	await writeFile(join(buildDir, "app", "[[...mdxPath]]", "page.tsx"), generateCatchAllPage(), "utf-8");
	await writeFile(join(buildDir, "mdx-components.tsx"), generateMdxComponents(), "utf-8");
	await writeFile(join(buildDir, "tsconfig.json"), generateTsConfig(), "utf-8");

	// Pack-specific stylesheet — only written when the user opts into a
	// non-default pack. Each pack's layout imports its own CSS file, so the
	// file has to land before `next dev` reads the layout module.
	if (config.theme?.pack === "forge") {
		await mkdir(join(buildDir, "app", "themes"), { recursive: true });
		const primaryHue = config.theme.primaryHue ?? 228;
		const fontFamily = config.theme.fontFamily ?? "inter";
		const css = buildForgeCss({
			accentHue: primaryHue,
			fontFamily: buildForgeFontFamilyCssValue(fontFamily),
		});
		await writeFile(join(buildDir, "app", "themes", "forge.css"), css, "utf-8");
	} else if (config.theme?.pack === "atlas") {
		await mkdir(join(buildDir, "app", "themes"), { recursive: true });
		const primaryHue = config.theme.primaryHue ?? 200;
		const fontFamily = config.theme.fontFamily ?? "source-serif";
		const css = buildAtlasCss({
			accentHue: primaryHue,
			fontFamily: buildAtlasFontFamilyCssValue(fontFamily),
		});
		await writeFile(join(buildDir, "app", "themes", "atlas.css"), css, "utf-8");
	}

	return { isNew };
}

// ─── generatePackageJson ──────────────────────────────────────────────────────

/**
 * Returns the contents of the `package.json` that should be written into the
 * hidden build directory.
 *
 * Includes all dependencies required by a Nextra v4 docs site:
 *   next, nextra, nextra-theme-docs, react, react-dom, and pagefind.
 *
 * The previous `swagger-ui-react` dependency is gone — the new OpenAPI
 * pipeline (Phase 4 of feature/openapi-rich-renderer) renders per-endpoint
 * MDX pages with a custom component tree, so the user's site no longer
 * pulls a Swagger UI bundle (~600 KB shaved off the runtime).
 */
/** Runtime dependencies for a Nextra v4 docs site. Shared with EngineManager. */
export const NEXTRA_DEPENDENCIES: Record<string, string> = {
	next: "^15.0.0",
	nextra: "4.2.17",
	"nextra-theme-docs": "4.2.17",
	react: "^19.0.0",
	"react-dom": "^19.0.0",
	pagefind: "^1.0.0",
};

/** Dev dependencies for a Nextra v4 docs site. Shared with EngineManager. */
export const NEXTRA_DEV_DEPENDENCIES: Record<string, string> = {
	"@types/react": "^19.0.0",
	typescript: "^5.0.0",
};

export function generatePackageJson(): string {
	const pkg = {
		name: "jolli-site",
		version: "0.0.1",
		private: true,
		scripts: {
			dev: "next dev",
			build: "next build",
			start: "next start",
		},
		dependencies: { ...NEXTRA_DEPENDENCIES },
		devDependencies: { ...NEXTRA_DEV_DEPENDENCIES },
	};

	return JSON.stringify(pkg, null, 2);
}

// ─── generateNextConfig ───────────────────────────────────────────────────────

/**
 * Returns the contents of `next.config.mjs` — a minimal valid Nextra v4
 * configuration that enables static export.
 *
 * Nextra v4 no longer accepts `theme` or `themeConfig` options — those are
 * configured via `app/layout.tsx` and `mdx-components.tsx` instead.
 */
export function generateNextConfig(staticExport?: boolean): string {
	const exportLines = staticExport ? `\n  output: 'export',\n  images: { unoptimized: true },` : "";

	return `import nextra from 'nextra'

const withNextra = nextra({
  contentDirBasePath: '/'
})

export default withNextra({${exportLines}
  webpack(config) {
    config.resolve.preferRelative = true
    return config
  }
})
`;
}

// ─── generateLayout helpers ──────────────────────────────────────────────────

/** Social platforms supported in the footer, in display order. */
const SOCIAL_PLATFORMS = ["github", "twitter", "discord", "linkedin", "youtube"] as const;

/**
 * Allow http(s), mailto, tel, fragments, query strings, and absolute or
 * relative paths. Anything else (e.g. `javascript:`, `data:`, `vbscript:`)
 * is replaced with `"#"` so a malicious site.json can't inject a script URL.
 */
function sanitizeUrl(url: string): string {
	const trimmed = url.trim();
	if (trimmed === "" || /^(?:https?:|mailto:|tel:|[#?/]|\.\.?\/)/i.test(trimmed)) {
		return trimmed;
	}
	return "#";
}

/**
 * Resolves the navbar's logical item list. `header.items` wins when set;
 * otherwise the legacy flat `nav` is coerced into dropdown-less items so
 * pre-`header` site.json files keep rendering unchanged.
 */
function resolveHeaderItems(config: NextraProjectConfig): HeaderItem[] {
	if (config.header?.items && config.header.items.length > 0) {
		return config.header.items;
	}
	return config.nav.map((n) => ({ label: n.label, url: n.href }));
}

/** Renders a single header item — either an `<a>` or a `<details>` dropdown. */
function renderNavbarChild(item: HeaderItem): string {
	const jsLabel = JSON.stringify(item.label);
	if (item.items && item.items.length > 0) {
		const subLinks = item.items
			.map((sub) => {
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
					.map((link) => {
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

// ─── generateLayout (dispatcher) ─────────────────────────────────────────────

/**
 * Returns the contents of `app/layout.tsx`. Dispatches to a pack-specific
 * generator based on `config.theme?.pack`:
 *   - `default` (or unset) → vanilla `nextra-theme-docs` with header/footer
 *   - `forge` → Forge pack (clean dev docs)
 *   - `atlas` → Atlas pack (editorial)
 */
export function generateLayout(config: NextraProjectConfig): string {
	const pack: ThemePack = config.theme?.pack ?? "default";
	switch (pack) {
		case "forge":
			return generateForgeLayout(config);
		case "atlas":
			return generateAtlasLayout(config);
		default:
			return generateDefaultLayout(config);
	}
}

// ─── generateDefaultLayout ───────────────────────────────────────────────────

/**
 * Vanilla `nextra-theme-docs` layout with header dropdown and footer support.
 * Maps `title`, `description`, `nav` / `header`, and `footer` from `site.json`
 * into the Nextra Layout, Navbar, and Footer components. `nav` is the legacy
 * flat shorthand; `header.items` (which supports per-item dropdowns) wins
 * when set.
 */
export function generateDefaultLayout(config: NextraProjectConfig): string {
	const { title, description } = config;

	const jsTitle = JSON.stringify(title);
	const jsDescription = JSON.stringify(description);

	const headerItems = resolveHeaderItems(config);
	const navLinks = headerItems.map(renderNavbarChild).join("\n");
	const navbarChildren = headerItems.length > 0 ? `\n${navLinks}\n        ` : "";

	const footerBody = buildFooterBody(config.footer);
	const footerJsx = footerBody === "" ? `<Footer />` : `<Footer>\n${footerBody}\n      </Footer>`;

	return `import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'
import '../styles/api.css'

export const metadata = {
  title: ${jsTitle},
  description: ${jsDescription},
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={
            <Navbar logo={<b>{${jsTitle}}</b>}>${navbarChildren}</Navbar>
          }
          pageMap={await getPageMap()}
          footer={${footerJsx}}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
`;
}

// ─── generateForgeLayout ─────────────────────────────────────────────────────

/**
 * Forge pack layout — clean developer-docs visual style. The pack-specific
 * stylesheet is written to `app/themes/forge.css` by `initNextraProject`.
 * See `themes/forge/Layout.ts` for the template and the SaaS-port notes.
 */
export function generateForgeLayout(config: NextraProjectConfig): string {
	const input = resolveForgeLayoutInput({
		title: config.title,
		description: config.description,
		nav: config.nav,
		header: config.header,
		footer: config.footer,
		theme: config.theme,
		legacyFavicon: config.favicon,
	});
	return generateForgeLayoutTsx(input);
}

// ─── generateAtlasLayout ─────────────────────────────────────────────────────

/**
 * Atlas pack layout — editorial handbook visual style. The pack-specific
 * stylesheet is written to `app/themes/atlas.css` by `initNextraProject`.
 * See `themes/atlas/Layout.ts` for the template and the SaaS-port notes.
 */
export function generateAtlasLayout(config: NextraProjectConfig): string {
	const input = resolveAtlasLayoutInput({
		title: config.title,
		description: config.description,
		nav: config.nav,
		header: config.header,
		footer: config.footer,
		theme: config.theme,
		legacyFavicon: config.favicon,
	});
	return generateAtlasLayoutTsx(input);
}

// ─── generateNotFound ───────────────────────────────────────────────────────

/**
 * Returns the contents of `app/not-found.tsx` — required by Next.js 15 during
 * static export to resolve the `/_not-found` route.
 *
 * Re-exports the themed 404 page from `nextra-theme-docs`, matching the
 * pattern used in Nextra v4's own example projects.
 */
export function generateNotFound(): string {
	return `export { NotFoundPage as default } from 'nextra-theme-docs'
`;
}

// ─── generateMdxComponents ───────────────────────────────────────────────────

/**
 * Returns the contents of `mdx-components.tsx` — required by Nextra v4 to
 * wire up the docs theme's MDX components.
 */
export function generateMdxComponents(): string {
	return `import { useMDXComponents as getDocsMDXComponents } from 'nextra-theme-docs'

const docsComponents = getDocsMDXComponents()

export function useMDXComponents(components: Record<string, React.ComponentType>) {
  return {
    ...docsComponents,
    ...components,
  }
}
`;
}

// ─── generateCatchAllPage ────────────────────────────────────────────────────

/**
 * Returns the contents of `app/[[...mdxPath]]/page.tsx` — the catch-all route
 * required by Nextra v4 to render content from the `content/` directory.
 *
 * Uses `importPage` and `generateStaticParamsFor` from `nextra/pages` and
 * the `wrapper` component from `mdx-components` to render each page with
 * its table of contents and metadata.
 */
export function generateCatchAllPage(): string {
	return `import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { useMDXComponents } from '../../mdx-components'

export const generateStaticParams = generateStaticParamsFor('mdxPath')

export async function generateMetadata(props: { params: Promise<{ mdxPath?: string[] }> }) {
  const params = await props.params
  const { metadata } = await importPage(params.mdxPath)
  return metadata
}

const Wrapper = useMDXComponents({}).wrapper

export default async function Page(props: { params: Promise<{ mdxPath?: string[] }> }) {
  const params = await props.params
  const result = await importPage(params.mdxPath)
  const { default: MDXContent, toc, metadata } = result
  return (
    <Wrapper toc={toc} metadata={metadata}>
      <MDXContent />
    </Wrapper>
  )
}
`;
}

// ─── generateTsConfig ────────────────────────────────────────────────────────

/**
 * Returns a minimal `tsconfig.json` for the generated Nextra v4 project.
 *
 * The `@/*` path alias maps to the build root so the generated MDX shims
 * can import `@/components/api/Endpoint` without depending on how deep
 * each shim sits under `content/`. Next.js resolves the same alias at
 * bundle time via the same tsconfig.
 */
export function generateTsConfig(): string {
	const tsconfig = {
		compilerOptions: {
			target: "ES2020",
			lib: ["ES2020", "DOM", "DOM.Iterable"],
			jsx: "preserve",
			module: "ESNext",
			moduleResolution: "bundler",
			resolveJsonModule: true,
			isolatedModules: true,
			strict: true,
			skipLibCheck: true,
			esModuleInterop: true,
			baseUrl: ".",
			paths: { "@/*": ["./*"] },
		},
		include: ["**/*.ts", "**/*.tsx", "mdx-components.tsx"],
		exclude: ["node_modules"],
	};

	return JSON.stringify(tsconfig, null, 2);
}
