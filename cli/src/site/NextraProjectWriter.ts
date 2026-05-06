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

// ─── NextraProjectConfig ──────────────────────────────────────────────────────

/**
 * Configuration derived from `site.json` that drives the generated Nextra
 * project files.
 */
export interface NextraProjectConfig {
	title: string;
	description: string;
	nav: Array<{ label: string; href: string }>;
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

// ─── generateLayout ──────────────────────────────────────────────────────────

/**
 * Returns the contents of `app/layout.tsx` — the root layout for the Nextra v4
 * docs theme.
 *
 * Maps `title`, `description`, and `nav` from `site.json` into the Nextra
 * Layout, Navbar, and Footer components.
 */
export function generateLayout(config: NextraProjectConfig): string {
	const { title, description, nav } = config;

	const jsTitle = JSON.stringify(title);
	const jsDescription = JSON.stringify(description);

	// Build navbar children from nav items (Navbar uses `children` for extra content).
	const navLinks = nav
		.map(({ label, href }) => {
			const jsLabel = JSON.stringify(label);
			const jsHref = JSON.stringify(href);
			return `          <a href={${jsHref}} style={{ marginLeft: '1rem' }}>{${jsLabel}}</a>`;
		})
		.join("\n");

	const navbarChildren = nav.length > 0 ? `\n${navLinks}\n        ` : "";

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
          footer={<Footer />}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
`;
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
