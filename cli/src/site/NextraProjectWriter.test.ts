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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-nextrawriter-test-"));
}

const SAMPLE_CONFIG = {
	title: "My API Docs",
	description: "Documentation for My API",
	nav: [
		{ label: "Home", href: "/" },
		{ label: "GitHub", href: "https://github.com/example" },
	],
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

	it("includes 'swagger-ui-react' dependency", async () => {
		const { generatePackageJson } = await import("./NextraProjectWriter.js");
		const pkg = JSON.parse(generatePackageJson());
		expect(pkg.dependencies).toHaveProperty("swagger-ui-react");
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

	it("contains nav item labels", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout(SAMPLE_CONFIG);
		expect(result).toContain("Home");
		expect(result).toContain("GitHub");
	});

	it("contains nav item hrefs", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");
		const result = generateLayout(SAMPLE_CONFIG);
		expect(result).toContain("/");
		expect(result).toContain("https://github.com/example");
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
});

// ─── initNextraProject unit tests ────────────────────────────────────────────

describe("NextraProjectWriter.initNextraProject", () => {
	let tempDir: string;

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

	it("regenerates app/layout.tsx with updated nav on subsequent run", async () => {
		const { initNextraProject } = await import("./NextraProjectWriter.js");
		const buildDir = join(tempDir, ".jolli-site");

		await initNextraProject(buildDir, SAMPLE_CONFIG);

		const updatedConfig = {
			...SAMPLE_CONFIG,
			nav: [{ label: "New Link", href: "/new" }],
		};
		await initNextraProject(buildDir, updatedConfig);

		const layoutContent = await readFile(join(buildDir, "app", "layout.tsx"), "utf-8");
		expect(layoutContent).toContain("New Link");
		expect(layoutContent).toContain("/new");
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
		expect(pkg.dependencies).toHaveProperty("swagger-ui-react");
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

	it("generateLayout always contains all nav item labels", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");

		fc.assert(
			fc.property(
				nonEmptyString,
				nonEmptyString,
				fc.array(navItem, { minLength: 1, maxLength: 5 }),
				(title, description, nav) => {
					const config = { title, description, nav };
					const result = generateLayout(config);
					return nav.every(({ label }) => result.includes(label));
				},
			),
			{ numRuns: 100 },
		);
	});

	it("generateLayout always contains all nav item hrefs", async () => {
		const { generateLayout } = await import("./NextraProjectWriter.js");

		fc.assert(
			fc.property(
				nonEmptyString,
				nonEmptyString,
				fc.array(navItem, { minLength: 1, maxLength: 5 }),
				(title, description, nav) => {
					const config = { title, description, nav };
					const result = generateLayout(config);
					return nav.every(({ href }) => result.includes(href));
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

		const requiredDeps = [
			"next",
			"nextra",
			"nextra-theme-docs",
			"react",
			"react-dom",
			"swagger-ui-react",
			"pagefind",
		];

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
