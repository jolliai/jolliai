/**
 * Tests for the I/O half of MetaGenerator: `generateMetaFiles`,
 * sidebar-overrides integration, and root-injection integration. The pure
 * half (`toTitleCase`, `buildMetaEntries`, property-based tests) lives in
 * `site-core/src/MetaGenerator.test.ts`.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-metagenerator-test-"));
}

// ─── generateMetaFiles unit tests ────────────────────────────────────────────

describe("MetaGenerator.generateMetaFiles", () => {
	let contentDir: string;

	beforeEach(async () => {
		contentDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(contentDir, { recursive: true, force: true });
	});

	// ── Basic _meta.js generation ────────────────────────────────────────────

	it("writes _meta.js in a folder containing a markdown file", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "guide.md"), "# Guide", "utf-8");

		await generateMetaFiles(contentDir);

		expect(existsSync(join(contentDir, "_meta.js"))).toBe(true);
	});

	it("_meta.js contains the correct ES module export", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "guide.md"), "# Guide", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain("export default");
		expect(content).toContain('"guide": "Guide"');
	});

	it("hides index.md in _meta.js with display: hidden", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "index.md"), "# Home", "utf-8");
		await writeFile(join(contentDir, "guide.md"), "# Guide", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain('"index"');
		expect(content).toContain('"hidden"');
		expect(content).toContain('"guide"');
	});

	it("omits the index key entirely when the index file declares asIndexPage:true", async () => {
		// Regression: Nextra v4 errors with "field key 'index' refers to a page
		// that cannot be found" when the index has `asIndexPage: true` (Nextra
		// promotes it to the folder's representative page and removes it from
		// children) AND `_meta.js` still references "index".
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(
			join(contentDir, "index.mdx"),
			"---\ntitle: Deployment\nasIndexPage: true\n---\n# Deployment",
			"utf-8",
		);
		await writeFile(join(contentDir, "docker.md"), "# Docker", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).not.toContain('"index"');
		expect(content).toContain('"docker"');
	});

	it("does NOT promote an index when asIndexPage appears as a nested YAML key", async () => {
		// Regression: the detector used to match `^\s*asIndexPage\s*: true` on
		// any indentation, so a nested key (e.g. `things:\n  asIndexPage: true`)
		// falsely registered as a top-level declaration. With the fix, the
		// index stays hidden (the standard `display: "hidden"` shape) so Nextra
		// keeps treating the folder as a regular grouping.
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(
			join(contentDir, "index.md"),
			"---\ntitle: Home\nthings:\n  asIndexPage: true\n---\n# Home",
			"utf-8",
		);
		await writeFile(join(contentDir, "docker.md"), "# Docker", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain('"index"');
		expect(content).toContain('"hidden"');
		expect(content).toContain('"docker"');
	});

	it("prefers index.mdx over index.md when both are present and asIndexPage is declared on the .mdx", async () => {
		// Regression: Nextra resolves to `index.mdx` when both files exist, but
		// the detector used to pick whichever readdir returned first (typically
		// alphabetical → `index.md` wins). With both files present and only the
		// `.mdx` declaring `asIndexPage: true`, the detector must agree with
		// what Nextra actually compiles.
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(
			join(contentDir, "index.mdx"),
			"---\ntitle: Deployment\nasIndexPage: true\n---\n# Deployment",
			"utf-8",
		);
		// Stale .md from a previous mirror without the flag.
		await writeFile(join(contentDir, "index.md"), "---\ntitle: Old\n---\n# Old", "utf-8");
		await writeFile(join(contentDir, "docker.md"), "# Docker", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		// The `.mdx` flag wins → index key is omitted entirely.
		expect(content).not.toContain('"index"');
		expect(content).toContain('"docker"');
	});

	it("_meta.js entries are sorted alphabetically", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "zebra.md"), "# Zebra", "utf-8");
		await writeFile(join(contentDir, "apple.md"), "# Apple", "utf-8");
		await writeFile(join(contentDir, "mango.md"), "# Mango", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		const applePos = content.indexOf('"apple"');
		const mangoPos = content.indexOf('"mango"');
		const zebraPos = content.indexOf('"zebra"');
		expect(applePos).toBeLessThan(mangoPos);
		expect(mangoPos).toBeLessThan(zebraPos);
	});

	// ── Empty folder skipping (5.4) ──────────────────────────────────────────

	it("does NOT write _meta.js for an empty folder (5.4)", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		// contentDir is empty

		await generateMetaFiles(contentDir);

		expect(existsSync(join(contentDir, "_meta.js"))).toBe(false);
	});

	it("does NOT write _meta.js for a folder containing only ignored files", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "notes.txt"), "ignored", "utf-8");

		await generateMetaFiles(contentDir);

		expect(existsSync(join(contentDir, "_meta.js"))).toBe(false);
	});

	// ── Subdirectory recursion ───────────────────────────────────────────────

	it("writes _meta.js in a non-empty subdirectory", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const guidesDir = join(contentDir, "guides");
		await mkdir(guidesDir, { recursive: true });
		await writeFile(join(guidesDir, "introduction.md"), "# Intro", "utf-8");

		await generateMetaFiles(contentDir);

		expect(existsSync(join(guidesDir, "_meta.js"))).toBe(true);
	});

	it("includes non-empty subdirectory in parent _meta.js", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const guidesDir = join(contentDir, "guides");
		await mkdir(guidesDir, { recursive: true });
		await writeFile(join(guidesDir, "introduction.md"), "# Intro", "utf-8");
		await writeFile(join(contentDir, "about.md"), "# About", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain('"guides"');
	});

	it("does NOT include an empty subdirectory in parent _meta.js", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const emptyDir = join(contentDir, "empty");
		await mkdir(emptyDir, { recursive: true });
		await writeFile(join(contentDir, "about.md"), "# About", "utf-8");

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).not.toContain('"empty"');
	});

	// ── Full example matching design doc ─────────────────────────────────────

	it("handles non-existent contentDir without throwing", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");

		// processDir catches readdir errors and returns false
		await expect(generateMetaFiles(join(contentDir, "nonexistent"))).resolves.not.toThrow();
	});

	it.skipIf(process.platform === "win32")("skips entries where stat fails (e.g. broken symlinks)", async () => {
		const { symlink } = await import("node:fs/promises");
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		// Create a valid file so _meta.js gets generated
		await writeFile(join(contentDir, "valid.md"), "# Valid", "utf-8");
		// Create a broken symlink — readdir lists it, but stat fails
		await symlink(join(contentDir, "nonexistent-target"), join(contentDir, "broken-link.md"));

		await generateMetaFiles(contentDir);

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain('"valid"');
		// broken-link should be skipped
		expect(content).not.toContain('"broken-link"');
	});

	it("generates correct _meta.js for a typical pages structure", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");

		// Root: index.md, getting-started.md, api/, guides/
		await writeFile(join(contentDir, "index.md"), "# Home", "utf-8");
		await writeFile(join(contentDir, "getting-started.md"), "# Getting Started", "utf-8");

		const apiDir = join(contentDir, "api");
		await mkdir(apiDir, { recursive: true });
		await writeFile(join(apiDir, "openapi.mdx"), "# API", "utf-8");

		const guidesDir = join(contentDir, "guides");
		await mkdir(guidesDir, { recursive: true });
		await writeFile(join(guidesDir, "introduction.md"), "# Intro", "utf-8");

		await generateMetaFiles(contentDir);

		// Root _meta.js
		const rootMeta = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(rootMeta).toContain('"api"');
		expect(rootMeta).toContain('"getting-started": "Getting Started"');
		expect(rootMeta).toContain('"guides"');
		expect(rootMeta).toContain('"index": {"display":"hidden"}');

		// api/_meta.js
		const apiMeta = await readFile(join(apiDir, "_meta.js"), "utf-8");
		expect(apiMeta).toContain('"openapi"');

		// guides/_meta.js
		const guidesMeta = await readFile(join(guidesDir, "_meta.js"), "utf-8");
		expect(guidesMeta).toContain('"introduction"');
	});

	// ── Sidebar overrides with generateMetaFiles ─────────────────────────────

	it("applies sidebar override to root directory", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "zebra.md"), "# Z", "utf-8");
		await writeFile(join(contentDir, "apple.md"), "# A", "utf-8");

		await generateMetaFiles(contentDir, {
			"/": { zebra: "Zebra First", apple: "Apple Second" },
		});

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		const zebraPos = content.indexOf('"zebra"');
		const applePos = content.indexOf('"apple"');
		expect(zebraPos).toBeLessThan(applePos);
		expect(content).toContain('"zebra": "Zebra First"');
	});

	it("applies sidebar override to subdirectory", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const subDir = join(contentDir, "guides");
		await mkdir(subDir, { recursive: true });
		await writeFile(join(subDir, "intro.md"), "# Intro", "utf-8");
		await writeFile(join(subDir, "advanced.md"), "# Adv", "utf-8");
		await writeFile(join(contentDir, "index.md"), "# Home", "utf-8");

		await generateMetaFiles(contentDir, {
			"/guides": { advanced: "Advanced First", intro: "Intro Second" },
		});

		const content = await readFile(join(subDir, "_meta.js"), "utf-8");
		const advPos = content.indexOf('"advanced"');
		const introPos = content.indexOf('"intro"');
		expect(advPos).toBeLessThan(introPos);
		expect(content).toContain('"advanced": "Advanced First"');
	});

	it("writes object values (external links) in _meta.js", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "index.md"), "# Home", "utf-8");

		await generateMetaFiles(contentDir, {
			"/": {
				index: "Home",
				github: { title: "GitHub", href: "https://github.com" },
			},
		});

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		expect(content).toContain('"github":');
		expect(content).toContain('"href":"https://github.com"');
	});

	it("uses default behavior for directories without override", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(contentDir, "zebra.md"), "# Z", "utf-8");
		await writeFile(join(contentDir, "apple.md"), "# A", "utf-8");

		await generateMetaFiles(contentDir, {
			"/other": { something: "Something" },
		});

		const content = await readFile(join(contentDir, "_meta.js"), "utf-8");
		const applePos = content.indexOf('"apple"');
		const zebraPos = content.indexOf('"zebra"');
		expect(applePos).toBeLessThan(zebraPos);
	});
});

// ─── generateMetaFiles with sidebar overrides ────────────────────────────────

describe("MetaGenerator.generateMetaFiles with sidebar overrides", () => {
	let pagesDir: string;

	beforeEach(async () => {
		pagesDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(pagesDir, { recursive: true, force: true });
	});

	it("auto-hides index when override doesn't mention it", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(pagesDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(pagesDir, "about.md"), "# About\n", "utf-8");
		const sidebar = { "/": { about: "About Us" } };

		await generateMetaFiles(pagesDir, sidebar);

		const metaContent = await readFile(join(pagesDir, "_meta.js"), "utf-8");
		expect(metaContent).toContain("index");
		expect(metaContent).toContain("hidden");
		expect(metaContent).toContain("About Us");
	});

	it("does not auto-hide index when override explicitly includes it", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await writeFile(join(pagesDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(pagesDir, "about.md"), "# About\n", "utf-8");
		const sidebar = { "/": { index: "Home Page", about: "About Us" } };

		await generateMetaFiles(pagesDir, sidebar);

		const metaContent = await readFile(join(pagesDir, "_meta.js"), "utf-8");
		expect(metaContent).toContain("Home Page");
	});
});

// ─── generateMetaFiles with rootInjection ────────────────────────────────────

describe("MetaGenerator.generateMetaFiles with rootInjection", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jolli-meta-inject-test-"));
		// Need at least one *visible* markdown file in the root for processDir
		// to write the root _meta.js — the folder-walker skips writing the
		// file when every entry is hidden (`index.md` alone counts as hidden).
		await writeFile(join(tempDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(tempDir, "about.md"), "# About\n", "utf-8");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function readRootMeta(): Promise<string> {
		return readFile(join(tempDir, "_meta.js"), "utf-8");
	}

	// ── No specs / no header.items: no injection ─────────────────────────────

	it("injects nothing when there are no specs and no header.items", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, { apiSpecs: [], headerItems: [] });
		const meta = await readRootMeta();
		expect(meta).not.toContain("__documentation");
		expect(meta).not.toContain("__api-reference");
	});

	it("injects nothing when rootInjection is omitted entirely", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir);
		const meta = await readRootMeta();
		expect(meta).not.toContain("__documentation");
	});

	// ── Single spec auto-injection ───────────────────────────────────────────

	it("single spec: injects __documentation + the per-spec entry as the visible API Reference link", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			apiSpecs: [{ specName: "petstore", title: "Petstore" }],
		});
		const meta = await readRootMeta();
		expect(meta).toContain('"__documentation":');
		expect(meta).toContain('"title":"Documentation"');
		expect(meta).toContain('"href":"/"');
		expect(meta).toContain('"api-petstore":');
		expect(meta).toContain('"title":"API Reference"');
		expect(meta).toContain('"href":"/api-petstore"');
		// Single-spec form does NOT emit the dropdown key.
		expect(meta).not.toContain("__api-reference");
	});

	// ── Multi-spec auto-injection ────────────────────────────────────────────

	it("multi-spec: emits hidden per-spec entries plus a visible __api-reference dropdown", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			apiSpecs: [
				{ specName: "petstore", title: "Petstore API" },
				{ specName: "users", title: "Users API" },
			],
		});
		const meta = await readRootMeta();
		// Per-spec entries — hidden navbar tabs.
		expect(meta).toContain('"api-petstore":');
		expect(meta).toContain('"display":"hidden"');
		expect(meta).toContain('"api-users":');
		// Visible dropdown.
		expect(meta).toContain('"__api-reference":');
		expect(meta).toContain('"type":"menu"');
		expect(meta).toContain('"href":"/api-petstore"');
		expect(meta).toContain('"href":"/api-users"');
	});

	it("multi-spec falls back to the slug as title when the parsed info.title is missing", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			apiSpecs: [{ specName: "petstore" }, { specName: "users", title: "" }],
		});
		const meta = await readRootMeta();
		expect(meta).toContain('"title":"petstore"');
		expect(meta).toContain('"title":"users"');
	});

	// ── User overrides win ───────────────────────────────────────────────────

	it("skips __documentation when the user declares a 'Documentation' header item", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			apiSpecs: [{ specName: "petstore" }],
			headerItems: [{ label: "Documentation", url: "/docs" }],
		});
		const meta = await readRootMeta();
		expect(meta).not.toContain("__documentation");
		// User entry survives, slug-keyed.
		expect(meta).toContain('"nav-documentation":');
		expect(meta).toContain('"href":"/docs"');
	});

	it("skips __api-reference when the user declares an 'API Reference' header item", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			apiSpecs: [{ specName: "petstore" }, { specName: "users" }],
			headerItems: [{ label: "API Reference", url: "/api" }],
		});
		const meta = await readRootMeta();
		expect(meta).not.toContain('"__api-reference":');
		// Per-spec hidden entries are still emitted (they're folder-bindings).
		expect(meta).toContain('"api-petstore":');
		// User entry survives.
		expect(meta).toContain('"nav-api-reference":');
	});

	it("matches override labels case-insensitively", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			apiSpecs: [{ specName: "petstore" }],
			headerItems: [{ label: "DOCUMENTATION", url: "/docs" }],
		});
		const meta = await readRootMeta();
		expect(meta).not.toContain("__documentation");
	});

	it("recognises the short label 'API' as an API Reference override", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			apiSpecs: [{ specName: "petstore" }],
			headerItems: [{ label: "API", url: "/api" }],
		});
		const meta = await readRootMeta();
		// Single-spec API Reference auto-entry is suppressed; the api-petstore
		// folder binding should not be emitted as a navbar link either.
		expect(meta).not.toContain('"title":"API Reference"');
	});

	// ── header.items materialisation ─────────────────────────────────────────

	it("materialises a flat header item as type:'page' with the configured href", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [{ label: "Pricing", url: "/pricing" }],
		});
		const meta = await readRootMeta();
		expect(meta).toContain('"nav-pricing":');
		expect(meta).toContain('"type":"page"');
		expect(meta).toContain('"href":"/pricing"');
	});

	it("materialises a header item with sub-items as type:'menu' with sub-entries", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [
				{
					label: "Resources",
					items: [
						{ label: "Blog", url: "/blog" },
						{ label: "Changelog", url: "/changelog" },
					],
				},
			],
		});
		const meta = await readRootMeta();
		expect(meta).toContain('"nav-resources":');
		expect(meta).toContain('"type":"menu"');
		expect(meta).toContain('"blog":{"title":"Blog","href":"/blog"}');
		expect(meta).toContain('"changelog":{"title":"Changelog","href":"/changelog"}');
	});

	// ── Security: URL sanitisation ───────────────────────────────────────────

	it("sanitises javascript: URLs in flat header.items[].url to '#'", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [{ label: "Bad", url: "javascript:alert(1)" }],
		});
		const meta = await readRootMeta();
		expect(meta).not.toMatch(/javascript:alert/i);
		expect(meta).toContain('"href":"#"');
	});

	it("sanitises javascript: URLs in dropdown sub-items to '#'", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [
				{
					label: "Menu",
					items: [{ label: "Bad", url: "JAVASCRIPT:alert(1)" }],
				},
			],
		});
		const meta = await readRootMeta();
		expect(meta).not.toMatch(/javascript:alert/i);
		expect(meta).toContain('"href":"#"');
	});

	it("sanitises data: and vbscript: URLs to '#'", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [
				{ label: "DataUrl", url: "data:text/html,<script>alert(1)</script>" },
				{ label: "VbsUrl", url: "vbscript:msgbox(1)" },
			],
		});
		const meta = await readRootMeta();
		expect(meta).not.toContain("data:text/html");
		expect(meta).not.toContain("vbscript:");
		expect(meta).not.toContain("<script>");
	});

	it("preserves http(s), mailto, tel, fragment, and relative hrefs unchanged", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [
				{ label: "Site", url: "https://example.com/path" },
				{ label: "Email", url: "mailto:hi@example.com" },
				{ label: "Phone", url: "tel:+15551234567" },
				{ label: "Fragment", url: "#section" },
				{ label: "Relative", url: "/path/to/page" },
			],
		});
		const meta = await readRootMeta();
		expect(meta).toContain("https://example.com/path");
		expect(meta).toContain("mailto:hi@example.com");
		expect(meta).toContain("tel:+15551234567");
		expect(meta).toContain("#section");
		expect(meta).toContain("/path/to/page");
	});

	// ── Key collision handling ───────────────────────────────────────────────

	it("does not overwrite existing _meta keys when sidebar overrides already declare them", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		// Sidebar override pins __documentation to a custom value.
		await generateMetaFiles(
			tempDir,
			{ "/": { __documentation: { title: "Custom Docs", href: "/docs" } } },
			{ apiSpecs: [{ specName: "petstore" }] },
		);
		const meta = await readRootMeta();
		expect(meta).toContain('"title":"Custom Docs"');
		expect(meta).toContain('"href":"/docs"');
		// And does not double-inject the same key.
		const occurrences = meta.match(/"__documentation":/g) ?? [];
		expect(occurrences.length).toBe(1);
	});

	it("disambiguates two header.items with identical labels by appending an index", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [
				{ label: "Docs", url: "/a" },
				{ label: "Docs", url: "/b" },
			],
		});
		const meta = await readRootMeta();
		// First gets `nav-docs`, second gets a suffixed key so both survive.
		expect(meta).toContain('"nav-docs":');
		expect(meta).toMatch(/"nav-docs-1":/);
		expect(meta).toContain("/a");
		expect(meta).toContain("/b");
	});

	it("disambiguates dropdown sub-items with identical labels so neither is silently overwritten", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [
				{
					label: "Resources",
					items: [
						{ label: "Blog", url: "/a" },
						{ label: "Blog", url: "/b" },
					],
				},
			],
		});
		const meta = await readRootMeta();
		// Both sub-items survive — first as `blog`, second with an index suffix.
		expect(meta).toContain('"blog":{"title":"Blog","href":"/a"}');
		expect(meta).toMatch(/"blog-1":\{"title":"Blog","href":"\/b"\}/);
	});

	it("falls back to nav-{idx} for header items whose label slugs to empty", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [{ label: "!!!", url: "/symbol" }],
		});
		const meta = await readRootMeta();
		expect(meta).toContain('"nav-0":');
		expect(meta).toContain('"href":"/symbol"');
	});

	// ── Defensive: malformed header items ────────────────────────────────────

	it("skips malformed header items missing 'label' instead of crashing the build", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Cast to bypass type check — site.json is parsed without shape validation
		// in production, so missing-label objects can reach injectRootNavEntries.
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [
				{ url: "/no-label" } as unknown as { label: string; url: string },
				{ label: "Valid", url: "/ok" },
			],
		});
		const meta = await readRootMeta();
		expect(meta).toContain('"nav-valid":');
		expect(meta).toContain("/ok");
		expect(meta).not.toContain("/no-label");
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("skips malformed dropdown sub-items missing 'label' instead of crashing", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [
				{
					label: "Resources",
					items: [
						{ url: "/no-label" } as unknown as { label: string; url: string },
						{ label: "Blog", url: "/blog" },
					],
				},
			],
		});
		const meta = await readRootMeta();
		expect(meta).toContain('"nav-resources":');
		expect(meta).toContain('"blog":{"title":"Blog","href":"/blog"}');
		expect(meta).not.toContain("/no-label");
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("skips header items with whitespace-only 'label'", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		await generateMetaFiles(tempDir, undefined, {
			headerItems: [
				{ label: "   ", url: "/whitespace" },
				{ label: "Real", url: "/real" },
			],
		});
		const meta = await readRootMeta();
		expect(meta).toContain('"nav-real":');
		expect(meta).not.toContain("/whitespace");
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// ── Non-root scope is unaffected ─────────────────────────────────────────

	it("does NOT inject auto-entries into nested folder _meta.js files", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await mkdir(join(tempDir, "guides"), { recursive: true });
		await writeFile(join(tempDir, "guides", "intro.md"), "# Intro\n", "utf-8");

		await generateMetaFiles(tempDir, undefined, { apiSpecs: [{ specName: "petstore" }] });

		const nestedMeta = await readFile(join(tempDir, "guides", "_meta.js"), "utf-8");
		expect(nestedMeta).not.toContain("__documentation");
		expect(nestedMeta).not.toContain("api-petstore");
	});

	it("injects structurePages as type:page entries in root _meta.js", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			structurePages: [
				{ key: "docs", title: "Documentation", href: "/" },
				{ key: "tutorials", title: "Tutorials", href: "/tutorials" },
			],
		});

		const content = await readFile(join(tempDir, "_meta.js"), "utf-8");
		expect(content).toContain('"docs"');
		expect(content).toContain('"Documentation"');
		expect(content).toContain('"type":"page"');
		expect(content).toContain('"tutorials"');
		expect(content).toContain('"Tutorials"');
	});

	it("structurePages do not duplicate existing keys", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(
			tempDir,
			{ "/": { about: "About Us" } },
			{
				structurePages: [{ key: "about", title: "About Tab", href: "/about" }],
			},
		);

		const content = await readFile(join(tempDir, "_meta.js"), "utf-8");
		// "about" is already in sidebar overrides, so structurePages should not duplicate it
		expect(content).toContain('"about"');
		// Should appear only once
		const matches = content.match(/"about"/g);
		expect(matches?.length).toBe(1);
	});

	it("renders page entries as type:page for sidebar scoping when defaultPageHref is set", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			structurePages: [
				{ key: "docs", title: "Documentation", href: "/docs" },
				{ key: "api", title: "API", href: "/api" },
			],
			defaultPageHref: "/docs",
		});

		const content = await readFile(join(tempDir, "_meta.js"), "utf-8");
		// Page entries use Nextra type:"page" for sidebar scoping
		expect(content).toContain('"docs"');
		expect(content).toContain('"Documentation"');
		expect(content).toContain('"type":"page"');
	});

	it("renders menu page entries as type:menu with items", async () => {
		const { generateMetaFiles } = await import("./MetaGenerator.js");
		await generateMetaFiles(tempDir, undefined, {
			structurePages: [
				{ key: "docs", title: "Documentation", href: "/docs" },
				{
					key: "community",
					title: "Community",
					href: "#",
					type: "menu",
					menuItems: {
						slack: { title: "Slack", href: "https://slack.example.com" },
						github: { title: "GitHub", href: "https://github.com/example" },
					},
				},
			],
		});

		const content = await readFile(join(tempDir, "_meta.js"), "utf-8");
		expect(content).toContain('"community"');
		expect(content).toContain('"Community"');
		expect(content).toContain('"type":"menu"');
		expect(content).toContain('"items"');
	});
});
