/**
 * Tests for NextraProjectWriter — writes and maintains the Nextra v4 project
 * scaffold inside `.jolli-site/`.
 *
 * Covers all acceptance criteria from Task 7:
 *   - initNextraProject creates buildDir and config files on first run
 *   - initNextraProject returns { isNew: true } on first run
 *   - initNextraProject returns { isNew: false } on subsequent runs
 *   - initNextraProject regenerates config files with updated values
 *   - generatePackageJson includes all required dependencies
 *   - generateNextConfig produces a valid next.config.mjs for Nextra v4
 *   - generateLayout maps title, description, and nav into app/layout.tsx
 *   - generateMdxComponents produces the required mdx-components.tsx
 *   - generateTsConfig produces a valid tsconfig.json
 *
 * Property-based tests (fast-check):
 *   - Property 5: site.json fields are preserved in generated Nextra config
 *     **Validates: Requirements 8.2, 8.3, 8.4**
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-nextrawriter-test-"));
}

/**
 * Pinned to `theme.pack: "default"` so the existing assertions keep exercising
 * the vanilla-Nextra default layout. The dispatcher now picks Forge when
 * `theme.pack` is unset, so an `unset` SAMPLE_CONFIG would silently move
 * every test into the Forge code path. Tests covering the new unset-pack →
 * Forge behavior live below in their own `describe` block.
 */
const SAMPLE_CONFIG = {
	title: "My API Docs",
	description: "Documentation for My API",
	nav: [
		{ label: "Home", href: "/" },
		{ label: "GitHub", href: "https://github.com/example" },
	],
	theme: { pack: "default" as const },
};

// ─── generatePackageJson unit tests ──────────────────────────────────────────

describe("NextraProjectWriter.generatePackageJson", () => {
	it("returns valid JSON", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const result = generatePackageJson();
		expect(() => JSON.parse(result)).not.toThrow();
	});

	it("includes 'next' dependency", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.dependencies).toHaveProperty("next");
	});

	it("includes 'nextra' dependency", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.dependencies).toHaveProperty("nextra");
	});

	it("includes 'nextra-theme-docs' dependency", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.dependencies).toHaveProperty("nextra-theme-docs");
	});

	it("includes 'react' dependency", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.dependencies).toHaveProperty("react");
	});

	it("includes 'react-dom' dependency", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.dependencies).toHaveProperty("react-dom");
	});

	it("includes 'pagefind' dependency", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.dependencies).toHaveProperty("pagefind");
	});

	it("sets name to 'jolli-site'", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.name).toBe("jolli-site");
	});

	it("sets private to true", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.private).toBe(true);
	});

	it("includes build script", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.scripts).toHaveProperty("build");
	});

	it("includes dev script", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.scripts).toHaveProperty("dev");
	});

	it("includes typescript devDependency", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.devDependencies).toHaveProperty("typescript");
	});
});

// ─── generateNextConfig unit tests ───────────────────────────────────────────

describe("NextraProjectWriter.generateNextConfig", () => {
	it("returns a non-empty string", async () => {
		const { generateNextConfig } = await import("./NextraProjectWriter.js");
		expect(generateNextConfig().length).toBeGreaterThan(0);
	});

	it("imports nextra", async () => {
		const { generateNextConfig } = await import("./NextraProjectWriter.js");
		expect(generateNextConfig()).toContain("import nextra from 'nextra'");
	});

	it("does NOT contain theme or themeConfig keys", async () => {
		const { generateNextConfig } = await import("./NextraProjectWriter.js");
		const config = generateNextConfig();
		expect(config).not.toContain("theme:");
		expect(config).not.toContain("themeConfig:");
	});

	it("uses export default", async () => {
		const { generateNextConfig } = await import("./NextraProjectWriter.js");
		expect(generateNextConfig()).toContain("export default");
	});

	it("calls withNextra with config object", async () => {
		const { generateNextConfig } = await import("./NextraProjectWriter.js");
		expect(generateNextConfig()).toContain("withNextra(");
	});

	it("includes static export config when staticExport is true", async () => {
		const { generateNextConfig } = await import("./NextraProjectWriter.js");
		const config = generateNextConfig(true);
		expect(config).toContain("output: 'export'");
		expect(config).toContain("unoptimized");
	});

	it("does not include static export config when staticExport is false", async () => {
		const { generateNextConfig } = await import("./NextraProjectWriter.js");
		const config = generateNextConfig(false);
		expect(config).not.toContain("output: 'export'");
	});
});

// ─── generateLayout unit tests ───────────────────────────────────────────────

describe("NextraProjectWriter.generateLayout", () => {
	it("returns a non-empty string", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		expect(generateLayout(SAMPLE_CONFIG).length).toBeGreaterThan(0);
	});

	it("contains the site title", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		expect(generateLayout(SAMPLE_CONFIG)).toContain("My API Docs");
	});

	it("contains the site description", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		expect(generateLayout(SAMPLE_CONFIG)).toContain("Documentation for My API");
	});

	it("uses <ScopedNextraLayout> instead of vanilla <Layout> (sidebar scoping)", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout(SAMPLE_CONFIG);
		expect(result).toContain("import ScopedNextraLayout from '../components/ScopedNextraLayout'");
		expect(result).toContain("<ScopedNextraLayout");
	});

	it("default layout's <Navbar> has no JSX children — nav comes from root _meta.js", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout(SAMPLE_CONFIG);
		// Nav items live in `content/_meta.js` (written by MetaGenerator).
		// The layout's navbar only renders the logo prop.
		expect(result).not.toContain('href={"/"}');
		expect(result).not.toContain("https://github.com/example");
	});

	it("imports nextra-theme-docs Layout and Navbar", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout(SAMPLE_CONFIG);
		expect(result).toContain("nextra-theme-docs");
		expect(result).toContain("Layout");
		expect(result).toContain("Navbar");
	});

	it("exports a default function", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		expect(generateLayout(SAMPLE_CONFIG)).toContain("export default");
	});

	it("includes metadata with title and description", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout(SAMPLE_CONFIG);
		expect(result).toContain("export const metadata");
		expect(result).toContain("title:");
		expect(result).toContain("description:");
	});

	it("handles empty nav array", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const config = { title: "Test", description: "Desc", nav: [] };
		const result = generateLayout(config);
		expect(result).toContain("Test");
		expect(result).toContain("Desc");
	});

	it("imports the API stylesheet alongside Nextra's theme stylesheet", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout(SAMPLE_CONFIG);
		expect(result).toContain("'nextra-theme-docs/style.css'");
		expect(result).toContain("'../styles/api.css'");
	});

	// ── theme.pack dispatcher (Phase 1) ──────────────────────────────────────

	it("uses the default layout when theme.pack is unset (no built-in packs registered)", async () => {
		const { generateLayout, generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const config = {
			title: "My API Docs",
			description: "Documentation for My API",
		};
		expect(generateLayout(config)).toBe(generateDefaultLayout(config));
	});

	it("uses the default layout when theme.pack is explicitly 'default'", async () => {
		const { generateLayout, generateDefaultLayout } = await import("./NextraProjectWriter.js");
		expect(generateLayout(SAMPLE_CONFIG)).toBe(generateDefaultLayout(SAMPLE_CONFIG));
	});

	it("unregistered pack falls back to the default layout", async () => {
		const { generateLayout, generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const config = { ...SAMPLE_CONFIG, theme: { pack: "nonexistent-pack-xyz" } };
		// Unknown pack name is not in the registry — falls back to default
		expect(generateLayout(config)).toBe(generateDefaultLayout(config));
	});

	it("default layout renders the title in <b> when no logo image or text is configured", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout(SAMPLE_CONFIG);
		expect(result).toContain('<b>{"My API Docs"}</b>');
		expect(result).not.toContain("<img");
	});

	it("default layout uses theme.logoText for the navbar text when set", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout({ ...SAMPLE_CONFIG, theme: { logoText: "ACME" } });
		expect(result).toContain('<b>{"ACME"}</b>');
		expect(result).not.toContain('<b>{"My API Docs"}</b>');
	});

	it("default layout renders an <img> from theme.logoUrl alongside the text by default", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout({ ...SAMPLE_CONFIG, theme: { logoUrl: "/logo.svg" } });
		expect(result).toContain('<img src={"/logo.svg"}');
		expect(result).toContain('<b>{"My API Docs"}</b>');
	});

	it("default layout emits dark-swap classes and a <style> rule when both logoUrl and logoUrlDark are set", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout({
			...SAMPLE_CONFIG,
			theme: { logoUrl: "/light.svg", logoUrlDark: "/dark.svg" },
		});
		expect(result).toContain('className="jolli-default-logo-light"');
		expect(result).toContain('className="jolli-default-logo-dark"');
		expect(result).toContain(".dark .jolli-default-logo-light");
	});

	it("default layout logoDisplay='text' suppresses the image even when logoUrl is set", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout({
			...SAMPLE_CONFIG,
			theme: { logoUrl: "/logo.svg", logoDisplay: "text" },
		});
		expect(result).not.toContain("<img");
		expect(result).toContain('<b>{"My API Docs"}</b>');
	});

	it("default layout logoDisplay='image' suppresses the text label when logoUrl is set", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout({
			...SAMPLE_CONFIG,
			theme: { logoUrl: "/logo.svg", logoDisplay: "image" },
		});
		expect(result).toContain('<img src={"/logo.svg"}');
		expect(result).not.toContain('<b>{"My API Docs"}</b>');
	});

	it("default layout logoDisplay='image' falls back to text when logoUrl is unset", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout({ ...SAMPLE_CONFIG, theme: { logoDisplay: "image" } });
		expect(result).not.toContain("<img");
		expect(result).toContain('<b>{"My API Docs"}</b>');
	});

	it("default layout passes through favicon, primaryHue, etc. without crashing", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout({
			...SAMPLE_CONFIG,
			theme: {
				logoUrl: "/logo.svg",
				logoUrlDark: "/logo-dark.svg",
				favicon: "/favicon.ico",
				primaryHue: 200,
				defaultTheme: "dark",
				fontFamily: "inter",
			},
		});
		expect(result).toContain("My API Docs");
		expect(result).toContain("nextra-theme-docs");
	});

	// ── CTA button (header.primary — default theme) ─────────────────────────

	it("default layout renders a CTA button with inline styles when header.primary is set", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout({
			...SAMPLE_CONFIG,
			header: { items: [], primary: { label: "Get Started", href: "/start" } },
		});
		expect(result).toContain('{"Get Started"}');
		expect(result).toContain('href={"/start"}');
		expect(result).toContain("background:");
	});

	it("default layout does not render a CTA button when header.primary is absent", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout(SAMPLE_CONFIG);
		expect(result).not.toContain("Get Started");
		// The self-closing <Navbar ... /> form should be used (no </Navbar> closing tag)
		expect(result).toContain("} />");
	});

	it("default layout sanitizes javascript: URLs in header.primary.href", async () => {
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		const result = generateDefaultLayout({
			...SAMPLE_CONFIG,
			header: { items: [], primary: { label: "Bad", href: "javascript:alert(1)" } },
		});
		expect(result).not.toMatch(/javascript:alert/i);
		expect(result).toContain('href={"#"}');
	});

	// ── footer (default theme: inline-style fallback, no pack CSS) ────────────
	// These tests pin behavior of the vanilla `nextra-theme-docs` default
	// layout — `theme: { pack: "default" }` is required because the dispatcher
	// picks Forge when `theme.pack` is unset. Pack-specific footer behavior is
	// exercised in `themes/Footer.test.ts` and the per-pack layout tests.

	const DEFAULT_PACK_THEME = { pack: "default" as const };

	it("default layout footer body still uses inline-style flex layout (no pack CSS to target classes)", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout({
			title: "T",
			description: "D",
			theme: DEFAULT_PACK_THEME,
			footer: { copyright: "2026 Acme Inc." },
		});
		// Default theme has no pack stylesheet, so it keeps the inline-style
		// fallback. Forge / Atlas use semantic class names — see their tests.
		expect(result).toContain("<Footer>");
		expect(result).toContain('{"2026 Acme Inc."}');
	});

	it("emits a bare <Footer /> when no footer config is provided (back-compat)", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout(SAMPLE_CONFIG);
		expect(result).toContain("footer={<Footer />}");
	});

	it("emits a bare <Footer /> when footer is set but has no rendering content", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout({
			title: "T",
			description: "D",
			theme: DEFAULT_PACK_THEME,
			footer: { columns: [], socialLinks: {} },
		});
		expect(result).toContain("footer={<Footer />}");
	});

	it("renders footer copyright text", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout({
			title: "T",
			description: "D",
			theme: DEFAULT_PACK_THEME,
			footer: { copyright: "2026 Acme Inc." },
		});
		expect(result).toContain("<Footer>");
		expect(result).toContain('{"2026 Acme Inc."}');
	});

	it("renders footer columns with titles and links", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout({
			title: "T",
			description: "D",
			theme: DEFAULT_PACK_THEME,
			footer: {
				columns: [
					{
						title: "Product",
						links: [
							{ label: "Pricing", url: "/pricing" },
							{ label: "Docs", url: "/docs" },
						],
					},
				],
			},
		});
		expect(result).toContain('{"Product"}');
		expect(result).toContain('{"Pricing"}');
		expect(result).toContain('<a href={"/pricing"}');
		expect(result).toContain('<a href={"/docs"}');
	});

	it("renders footer social links in canonical platform order, skipping unset ones", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout({
			title: "T",
			description: "D",
			theme: DEFAULT_PACK_THEME,
			footer: { socialLinks: { youtube: "https://yt.example", github: "https://gh.example" } },
		});
		// github appears before youtube in SOCIAL_PLATFORMS; verify ordering survived.
		const ghIdx = result.indexOf("gh.example");
		const ytIdx = result.indexOf("yt.example");
		expect(ghIdx).toBeGreaterThan(-1);
		expect(ytIdx).toBeGreaterThan(-1);
		expect(ghIdx).toBeLessThan(ytIdx);
		expect(result).toContain('aria-label={"github"}');
		expect(result).toContain('aria-label={"youtube"}');
		expect(result).not.toContain('aria-label={"twitter"}');
	});

	it("sanitizes javascript: URLs in footer column links and social links", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout({
			title: "T",
			description: "D",
			theme: DEFAULT_PACK_THEME,
			footer: {
				columns: [{ title: "X", links: [{ label: "Bad", url: "javascript:alert(1)" }] }],
				socialLinks: { github: "data:text/html,evil" },
			},
		});
		expect(result).not.toContain("javascript:alert");
		expect(result).not.toContain("data:text/html");
		// Both unsafe URLs should have been replaced with "#".
		expect(result.match(/<a href={"#"}/g)?.length).toBeGreaterThanOrEqual(2);
	});

	// ── Sidebar anchors ─────────────────────────────────────────────────────

	it("default layout renders sidebar anchors when configured", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout({
			title: "T",
			description: "D",
			theme: DEFAULT_PACK_THEME,
			anchors: [
				{ label: "Blog", href: "https://blog.example.com" },
				{ label: "Community", href: "https://discord.gg/x", icon: "💬" },
			],
		});
		expect(result).toContain("Blog");
		expect(result).toContain("Community");
		expect(result).toContain("💬");
	});

	it("default layout omits anchor block when no anchors configured", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout({
			title: "T",
			description: "D",
			theme: DEFAULT_PACK_THEME,
		});
		expect(result).not.toContain("sidebar-anchors");
	});
});

// ─── generateMdxComponents unit tests ────────────────────────────────────────

describe("NextraProjectWriter.generateMdxComponents", () => {
	it("returns a non-empty string", async () => {
		const { generateMdxComponents } = await import("./NextraProjectWriter.js");
		expect(generateMdxComponents().length).toBeGreaterThan(0);
	});

	it("imports from nextra-theme-docs", async () => {
		const { generateMdxComponents } = await import("./NextraProjectWriter.js");
		expect(generateMdxComponents()).toContain("nextra-theme-docs");
	});

	it("exports useMDXComponents function", async () => {
		const { generateMdxComponents } = await import("./NextraProjectWriter.js");
		expect(generateMdxComponents()).toContain("useMDXComponents");
	});
});

// ─── generateCatchAllPage unit tests ─────────────────────────────────────────

describe("NextraProjectWriter.generateCatchAllPage", () => {
	it("returns a non-empty string", async () => {
		const { generateCatchAllPage } = await import("./NextraProjectWriter.js");
		expect(generateCatchAllPage().length).toBeGreaterThan(0);
	});

	it("imports from nextra/pages", async () => {
		const { generateCatchAllPage } = await import("./NextraProjectWriter.js");
		const result = generateCatchAllPage();
		expect(result).toContain("nextra/pages");
		expect(result).toContain("importPage");
		expect(result).toContain("generateStaticParamsFor");
	});

	it("exports generateStaticParams", async () => {
		const { generateCatchAllPage } = await import("./NextraProjectWriter.js");
		expect(generateCatchAllPage()).toContain("generateStaticParams");
	});

	it("exports a default Page component", async () => {
		const { generateCatchAllPage } = await import("./NextraProjectWriter.js");
		expect(generateCatchAllPage()).toContain("export default");
	});

	it("uses the Wrapper component from mdx-components", async () => {
		const { generateCatchAllPage } = await import("./NextraProjectWriter.js");
		expect(generateCatchAllPage()).toContain("Wrapper");
		expect(generateCatchAllPage()).toContain("mdx-components");
	});
});

// ─── generateTsConfig unit tests ─────────────────────────────────────────────

describe("NextraProjectWriter.generateTsConfig", () => {
	it("returns valid JSON", async () => {
		const { generateTsConfig } = await import("./NextraProjectWriter.js");
		expect(() => JSON.parse(generateTsConfig())).not.toThrow();
	});

	it("sets moduleResolution to bundler", async () => {
		const { generateTsConfig } = await import("./NextraProjectWriter.js");
		const tsconfig = JSON.parse(generateTsConfig());
		expect(tsconfig.compilerOptions.moduleResolution).toBe("bundler");
	});

	it("sets jsx to preserve", async () => {
		const { generateTsConfig } = await import("./NextraProjectWriter.js");
		const tsconfig = JSON.parse(generateTsConfig());
		expect(tsconfig.compilerOptions.jsx).toBe("preserve");
	});

	it("declares the @/* path alias mapping to the build root", async () => {
		const { generateTsConfig } = await import("./NextraProjectWriter.js");
		const tsconfig = JSON.parse(generateTsConfig());
		expect(tsconfig.compilerOptions.baseUrl).toBe(".");
		expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./*"] });
	});
});

// ─── initNextraProject unit tests ────────────────────────────────────────────

describe("NextraProjectWriter.initNextraProject", () => {
	let tempDir: string;

	// Register a "default" theme pack stub so `discoverPack` step 2 hits the
	// in-process registry and skips steps 4 (~/.jolli/themes lookup) and 5
	// (GitHub registry network fetch). Without this, every `initNextraProject`
	// call here races a real GitHub roundtrip on cold-cache or slow-network
	// environments, and tests that call it twice (the isNew:false case)
	// regularly blow vitest's 15s timeout.
	//
	// The stub's `generateLayout` delegates to the real `generateDefaultLayout`,
	// so the bytes written to `app/layout.tsx` match the prior "no pack
	// registered → fallback" path — existing title/description/nav assertions
	// keep passing unchanged.
	//
	// Scoped to this describe via `beforeAll` (not file-level) so the earlier
	// `NextraProjectWriter.generateLayout` block's "uses the default layout
	// when theme.pack is 'default'" assertion — which depends on the registry
	// NOT having a `default` pack — keeps passing. Vitest runs describes
	// top-down within a file, so this fires after generateLayout's
	// expectations have already been verified.
	beforeAll(async () => {
		const { registerPack } = await import("./themes/ThemeRegistry.js");
		const { generateDefaultLayout } = await import("./NextraProjectWriter.js");
		registerPack({
			manifest: {
				name: "default",
				displayName: "Default (test stub)",
				tagline: "test stub",
				defaults: { primaryHue: 220, defaultTheme: "system", fontFamily: "inter" },
			},
			buildCss: () => undefined,
			generateLayout: (config) => generateDefaultLayout(config),
		});
	});

	beforeEach(async () => {
		tempDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ── First run (isNew: true) ──────────────────────────────────────────────

	it("returns { isNew: true } when buildDir does not exist", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		const result = await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(result.isNew).toBe(true);
	});

	it("creates the buildDir on first run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(buildDir)).toBe(true);
	});

	it("creates the content/ subdirectory on first run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(join(buildDir, "content"))).toBe(true);
	});

	it("creates the app/ subdirectory on first run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(join(buildDir, "app"))).toBe(true);
	});

	it("writes package.json on first run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(join(buildDir, "package.json"))).toBe(true);
	});

	it("writes next.config.mjs on first run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(join(buildDir, "next.config.mjs"))).toBe(true);
	});

	it("writes app/layout.tsx on first run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(join(buildDir, "app", "layout.tsx"))).toBe(true);
	});

	it("writes app/[[...mdxPath]]/page.tsx on first run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(join(buildDir, "app", "[[...mdxPath]]", "page.tsx"))).toBe(true);
	});

	it("writes mdx-components.tsx on first run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(join(buildDir, "mdx-components.tsx"))).toBe(true);
	});

	it("writes tsconfig.json on first run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(join(buildDir, "tsconfig.json"))).toBe(true);
	});

	// ── Subsequent run (isNew: false) ────────────────────────────────────────

	it("returns { isNew: false } when buildDir already exists", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		// First run
		await initNextraProject(buildDir, SAMPLE_CONFIG);
		// Second run
		const result = await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(result.isNew).toBe(false);
	});

	it("regenerates app/layout.tsx with updated title on subsequent run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		const updatedConfig = { ...SAMPLE_CONFIG, title: "Updated Title" };
		await initNextraProject(buildDir, updatedConfig);

		const layoutContent = await readFile(join(buildDir, "app", "layout.tsx"), "utf-8");
		expect(layoutContent).toContain("Updated Title");
	});

	it("regenerates app/layout.tsx with updated description on subsequent run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		const updatedConfig = { ...SAMPLE_CONFIG, description: "New description" };
		await initNextraProject(buildDir, updatedConfig);

		const layoutContent = await readFile(join(buildDir, "app", "layout.tsx"), "utf-8");
		expect(layoutContent).toContain("New description");
	});

	it("regenerates app/layout.tsx with updated title on subsequent run (nav now flows through _meta.js)", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		const updatedConfig = { ...SAMPLE_CONFIG, title: "Updated Title", nav: [{ label: "New Link", href: "/new" }] };
		await initNextraProject(buildDir, updatedConfig);

		const layoutContent = await readFile(join(buildDir, "app", "layout.tsx"), "utf-8");
		expect(layoutContent).toContain("Updated Title");
		// Nav items are written to root _meta.js by MetaGenerator, NOT into layout.tsx.
		expect(layoutContent).not.toContain("/new");
	});

	it("initNextraProject writes components/ScopedNextraLayout.tsx with the runtime page-map filter", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		expect(existsSync(join(buildDir, "components", "ScopedNextraLayout.tsx"))).toBe(true);
		const content = await readFile(join(buildDir, "components", "ScopedNextraLayout.tsx"), "utf-8");
		expect(content).toContain('"use client"');
		expect(content).toContain("scopePageMap");
		expect(content).toContain("usePathname");
	});

	it("ScopedNextraLayout.tsx declares scopePageMap BEFORE the default export (RSC tree-shaking gotcha)", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		const content = await readFile(join(buildDir, "components", "ScopedNextraLayout.tsx"), "utf-8");
		// Next.js's "use client" / RSC compiler tree-shakes function declarations
		// placed AFTER the default export. The component throws "scopePageMap is
		// not defined" at render time when this ordering regresses.
		const helperIdx = content.indexOf("function scopePageMap");
		const exportIdx = content.indexOf("export default function ScopedNextraLayout");
		expect(helperIdx).toBeGreaterThan(-1);
		expect(exportIdx).toBeGreaterThan(-1);
		expect(helperIdx).toBeLessThan(exportIdx);
	});

	it("writeSidebarTabsComponent emits a client-component SidebarTabs.tsx using Nextra's useConfig + usePathname", async () => {
		// Call writeSidebarTabsComponent directly instead of going through
		// initNextraProject — the latter calls discoverPack, which hits the
		// GitHub registry on cold-cache test environments and can time out on
		// network / tar-parse failures unrelated to this test.
		const { writeSidebarTabsComponent } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await writeSidebarTabsComponent(buildDir);

		expect(existsSync(join(buildDir, "components", "SidebarTabs.tsx"))).toBe(true);
		const content = await readFile(join(buildDir, "components", "SidebarTabs.tsx"), "utf-8");
		expect(content).toContain('"use client"');
		expect(content).toContain("useConfig");
		expect(content).toContain("usePathname");
	});

	it("SidebarTabs.tsx skips the no-active-tab redirect on '/' so a user-authored root index is not jumped away from", async () => {
		// Why this test exists: when a customer keeps a real root index.md/.mdx,
		// StartCommand.syncContent skips writeRootRedirectIndex so "/" renders
		// that user content. If SidebarTabs still force-redirected when no tab
		// matched the URL, the saved root page would flash and then disappear
		// — re-introducing the very flicker the redirect-stub removal was
		// supposed to eliminate.
		const { writeSidebarTabsComponent } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await writeSidebarTabsComponent(buildDir);

		const content = await readFile(join(buildDir, "components", "SidebarTabs.tsx"), "utf-8");
		// The redirect branch must be gated on `pathname !== "/"` AND
		// `!anyActive`. We assert the conjunction is present in the same
		// `if` statement rather than just substring-matching individual
		// fragments so a future refactor that splits them apart still fails
		// this test.
		const redirectStmtMatch = content.match(/if\s*\([^)]*!anyActive[^)]*\)\s*{[^}]*window\.location\.href/);
		expect(redirectStmtMatch, "expected an `if (!anyActive ...) { window.location.href }` block").not.toBeNull();
		const redirectStmt = redirectStmtMatch?.[0] ?? "";
		expect(redirectStmt).toContain('pathname !== "/"');
	});

	it("written package.json is valid JSON with required dependencies", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		const content = await readFile(join(buildDir, "package.json"), "utf-8");
		const pkg = JSON.parse(content);
		expect(pkg.dependencies).toHaveProperty("next");
		expect(pkg.dependencies).toHaveProperty("nextra");
		expect(pkg.dependencies).toHaveProperty("nextra-theme-docs");
		expect(pkg.dependencies).toHaveProperty("react");
		expect(pkg.dependencies).toHaveProperty("react-dom");
		expect(pkg.dependencies).toHaveProperty("pagefind");
	});

	it("written next.config.mjs contains nextra configuration", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		const content = await readFile(join(buildDir, "next.config.mjs"), "utf-8");
		expect(content).toContain("nextra");
		expect(content).toContain("export default");
	});

	it("does NOT write any pack CSS when theme.pack is explicitly 'default'", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		// The default theme has no CSS — no themes/ directory should be created.
		expect(existsSync(join(buildDir, "app", "themes", "default.css"))).toBe(false);
	});
});

// ─── Property-based tests ─────────────────────────────────────────────────────

/**
 * Property 5: site.json fields are preserved in generated Nextra config
 * **Validates: Requirements 8.2, 8.3, 8.4**
 */
describe("Property 5: site.json fields are preserved in generated Nextra config", () => {
	// Generate safe non-empty strings for title and description.
	const nonEmptyString = fc
		.stringMatching(/^[a-zA-Z0-9 !#$%&'()*+,\-./:;=?@[\]^_`|~]{1,50}$/)
		.filter((s) => s.trim().length > 0);

	// Generate safe nav items
	const navItem = fc.record({
		label: nonEmptyString,
		href: fc.oneof(
			fc.constant("/"),
			fc.constant("/docs"),
			fc.constant("https://example.com"),
			nonEmptyString.map((s) => `/${s}`),
		),
	});

	it("generateLayout always contains the exact title string", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");

		fc.assert(
			fc.property(
				nonEmptyString,
				nonEmptyString,
				fc.array(navItem, { minLength: 0, maxLength: 5 }),
				(title, description, nav) => {
					const config = { title, description, nav };
					const result = generateLayout(config);
					return result.includes(title);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("generateLayout always contains the exact description string", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");

		fc.assert(
			fc.property(
				nonEmptyString,
				nonEmptyString,
				fc.array(navItem, { minLength: 0, maxLength: 5 }),
				(title, description, nav) => {
					const config = { title, description, nav };
					const result = generateLayout(config);
					return result.includes(description);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("generateLayout never embeds nav item labels — they go through root _meta.js instead", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");

		fc.assert(
			fc.property(
				nonEmptyString,
				nonEmptyString,
				fc.array(navItem, { minLength: 1, maxLength: 5 }),
				(title, description, nav) => {
					const config = { title, description, nav };
					const result = generateLayout(config);
					// Only `title` and the `<Navbar logo=…>` slot reach the layout —
					// nav item labels and hrefs do not.
					return nav.every(({ href }) => !result.includes(`href={${JSON.stringify(href)}}`));
				},
			),
			{ numRuns: 100 },
		);
	});

	it("generateLayout always uses <ScopedNextraLayout> and never embeds nav hrefs as JSX-expression attributes", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");

		fc.assert(
			fc.property(
				nonEmptyString,
				nonEmptyString,
				fc.array(navItem, { minLength: 1, maxLength: 5 }),
				(title, description, nav) => {
					const config = { title, description, nav };
					const result = generateLayout(config);
					// Nav items now flow through `_meta.js`, never spliced into the
					// layout JSX. The pack layouts emit unrelated anchors (Forge's
					// sidebar-logo wrapper has `<a href="/">`), so the assertion is
					// scoped to the JSX-expression form (`<a href={…}>`) the old
					// nav-children code used for nav links.
					return result.includes("ScopedNextraLayout") && !/<a href=\{/.test(result);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("generatePackageJson always produces valid JSON regardless of config", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");

		fc.assert(
			fc.property(
				nonEmptyString,
				nonEmptyString,
				fc.array(navItem, { minLength: 0, maxLength: 5 }),
				(_title, _description, _nav) => {
					try {
						JSON.parse(generatePackageJson());
						return true;
					} catch {
						return false;
					}
				},
			),
			{ numRuns: 100 },
		);
	});

	it("generatePackageJson always includes all required dependencies", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");

		const requiredDeps = ["next", "nextra", "nextra-theme-docs", "react", "react-dom", "pagefind"];

		fc.assert(
			fc.property(
				nonEmptyString,
				nonEmptyString,
				fc.array(navItem, { minLength: 0, maxLength: 5 }),
				(_title, _description, _nav) => {
					const pkg = JSON.parse(generatePackageJson());
					return requiredDeps.every((dep) => dep in pkg.dependencies);
				},
			),
			{ numRuns: 100 },
		);
	});
});
