import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyNavigationContentPlan, buildNavigationContentPlan } from "./ContentPlanner.js";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-content-plan-test-"));
}

describe("buildNavigationContentPlan", () => {
	it("maps navigation pages and groups onto target markdown paths (group.root is source-only)", () => {
		// `group.root: "guides"` tells the planner where to FIND `intro.mdx`
		// (under docs/guides/) but does NOT contribute to the target path:
		// the article lands at docs/intro.mdx because the schema treats the
		// group as a sidebar separator, not a URL prefix.
		const plan = buildNavigationContentPlan(
			[
				{
					page: "Documentation",
					root: "/docs",
					content: [
						{ article: "Getting Started", href: "getting-started" },
						{
							group: "Guides",
							root: "guides",
							content: [{ article: "Intro", href: "intro" }],
						},
					],
				},
			],
			["docs/getting-started.md", "docs/guides/intro.mdx"],
		);

		expect(plan.pages).toEqual([
			{
				sourceRelPath: "docs/getting-started.md",
				targetRelPath: "docs/getting-started.md",
				title: "Getting Started",
			},
			{
				sourceRelPath: "docs/guides/intro.mdx",
				targetRelPath: "docs/intro.mdx",
				title: "Intro",
			},
		]);
	});

	it("falls back to a unique basename match when the logical target differs from the physical source path", () => {
		const plan = buildNavigationContentPlan(
			[
				{
					page: "Documentation",
					root: "/docs",
					content: [{ article: "Intro", href: "intro" }],
				},
			],
			["intro.md"],
		);

		expect(plan.pages).toEqual([
			{
				sourceRelPath: "intro.md",
				targetRelPath: "docs/intro.md",
				title: "Intro",
			},
		]);
	});

	it("uses explicit source when href and physical source path differ", () => {
		const plan = buildNavigationContentPlan(
			[
				{
					page: "Documentation",
					root: "/docs",
					content: [
						{
							article: "Intro",
							href: "intro",
							source: "getting-started/welcome.mdx",
						},
					],
				},
			],
			["getting-started/welcome.mdx"],
		);

		expect(plan.pages).toEqual([
			{
				sourceRelPath: "getting-started/welcome.mdx",
				targetRelPath: "docs/intro.mdx",
				title: "Intro",
			},
		]);
	});

	it("accepts explicit source without markdown extension", () => {
		const plan = buildNavigationContentPlan(
			[
				{
					page: "Documentation",
					root: "/docs",
					content: [
						{
							article: "Reference",
							href: "reference",
							source: "reference/overview",
						},
					],
				},
			],
			["reference/overview.md"],
		);

		expect(plan.pages).toEqual([
			{
				sourceRelPath: "reference/overview.md",
				targetRelPath: "docs/reference.md",
				title: "Reference",
			},
		]);
	});

	it("uses page sourceRoot when the physical source directory differs from the logical root", () => {
		const plan = buildNavigationContentPlan(
			[
				{
					page: "Documentation",
					root: "/docs",
					sourceRoot: "knowledge-base",
					content: [{ article: "Intro", href: "intro" }],
				},
			],
			["knowledge-base/intro.md"],
		);

		expect(plan.pages).toEqual([
			{
				sourceRelPath: "knowledge-base/intro.md",
				targetRelPath: "docs/intro.md",
				title: "Intro",
			},
		]);
	});

	it("uses group sourceRoot to locate source files; target path stays flat under the page root", () => {
		const plan = buildNavigationContentPlan(
			[
				{
					page: "Documentation",
					root: "/docs",
					content: [
						{
							group: "Guides",
							root: "guides",
							sourceRoot: "manuals",
							content: [{ article: "Deploy", href: "deploy" }],
						},
					],
				},
			],
			["manuals/deploy.md"],
		);

		expect(plan.pages).toEqual([
			{
				sourceRelPath: "manuals/deploy.md",
				targetRelPath: "docs/deploy.md",
				title: "Deploy",
			},
		]);
	});

	it("writes parent article as index.<ext> inside its folder when it has nested children", () => {
		// When an article has both an `href` matching a source file AND nested
		// `articles`, the parent must be written as `<href>/index.<ext>` so the
		// children can live alongside it — Nextra v4 treats `<href>.<ext>` next
		// to `<href>/` as a layout conflict. With group.root inert for targets,
		// the deployment folder lands directly under the page root.
		const plan = buildNavigationContentPlan(
			[
				{
					page: "Get Started",
					root: "/docs",
					content: [
						{
							group: "Guides",
							root: "guides",
							content: [
								{
									article: "Deployment",
									href: "deployment",
									articles: [
										{ article: "Docker", href: "deployment/docker" },
										{ article: "Kubernetes", href: "deployment/kubernetes" },
									],
								},
							],
						},
					],
				},
			],
			[
				"docs/guides/deployment.mdx",
				"docs/guides/deployment/docker.mdx",
				"docs/guides/deployment/kubernetes.mdx",
			],
		);

		expect(plan.pages).toEqual([
			{
				sourceRelPath: "docs/guides/deployment.mdx",
				targetRelPath: "docs/deployment/index.mdx",
				title: "Deployment",
			},
			{
				sourceRelPath: "docs/guides/deployment/docker.mdx",
				targetRelPath: "docs/deployment/docker.mdx",
				title: "Docker",
			},
			{
				sourceRelPath: "docs/guides/deployment/kubernetes.mdx",
				targetRelPath: "docs/deployment/kubernetes.mdx",
				title: "Kubernetes",
			},
		]);
	});

	it("throws when two logical pages claim the same target path", () => {
		expect(() =>
			buildNavigationContentPlan(
				[
					{
						page: "Documentation",
						root: "/docs",
						content: [
							{ article: "Intro", href: "intro", source: "a.md" },
							{ article: "Overview", href: "intro", source: "b.md" },
						],
					},
				],
				["a.md", "b.md"],
			),
		).toThrow(/claimed by both/);
	});

	it("throws when one source file is mapped to multiple target paths", () => {
		expect(() =>
			buildNavigationContentPlan(
				[
					{
						page: "Documentation",
						root: "/docs",
						content: [
							{ article: "Intro", href: "intro", source: "shared.md" },
							{ article: "Overview", href: "overview", source: "shared.md" },
						],
					},
				],
				["shared.md"],
			),
		).toThrow(/mapped to both/);
	});
});

describe("applyNavigationContentPlan", () => {
	let sourceRoot: string;
	let contentDir: string;

	afterEach(async () => {
		if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true });
		if (contentDir) await rm(contentDir, { recursive: true, force: true });
	});

	it("rewrites planned markdown into navigation-defined targets and preserves root index", async () => {
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();
		await mkdir(join(sourceRoot, "assets"), { recursive: true });
		await mkdir(join(contentDir, "docs"), { recursive: true });

		await writeFile(join(sourceRoot, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceRoot, "intro.md"), "![Diagram](./assets/arch.png)\n", "utf-8");
		await writeFile(join(contentDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(contentDir, "intro.md"), "stale\n", "utf-8");

		const written = await applyNavigationContentPlan(sourceRoot, contentDir, ["index.md", "intro.md"], {
			pages: [{ sourceRelPath: "intro.md", targetRelPath: "docs/intro.md", title: "Intro" }],
		});

		expect(written).toEqual(["index.md", "docs/intro.md"]);
		expect(existsSync(join(contentDir, "intro.md"))).toBe(false);
		expect(existsSync(join(contentDir, "index.md"))).toBe(true);
		expect(existsSync(join(contentDir, "docs", "intro.md"))).toBe(true);
		const rewritten = await readFile(join(contentDir, "docs", "intro.md"), "utf-8");
		expect(rewritten).toContain("![Diagram](../assets/arch.png)");
	});

	it("injects asIndexPage:true frontmatter when a non-index source is re-homed to <folder>/index.<ext>", async () => {
		// Regression for the parent-article-with-nested-children case: the
		// planner writes `<href>/index.<ext>` instead of `<href>.<ext>` so the
		// folder can hold child pages, and the frontmatter flag makes Nextra v4
		// route the folder header to the index (instead of just expanding) and
		// suppress the duplicate auto-discovered index entry in the sidebar.
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();

		// No existing frontmatter → flag block is prepended.
		await writeFile(join(sourceRoot, "deployment.mdx"), "# Deployment\nBody.\n", "utf-8");
		// Existing frontmatter → flag is merged in.
		await writeFile(join(sourceRoot, "operations.mdx"), "---\ntitle: Ops\n---\n# Operations\n", "utf-8");
		// Real index source (basename === index) → flag NOT injected; we only
		// touch frontmatter when we renamed a non-index source into an index slot.
		await writeFile(join(sourceRoot, "home.mdx"), "---\ntitle: Home\n---\n# Home\n", "utf-8");

		await applyNavigationContentPlan(sourceRoot, contentDir, ["deployment.mdx", "operations.mdx", "home.mdx"], {
			pages: [
				{ sourceRelPath: "deployment.mdx", targetRelPath: "guides/deployment/index.mdx", title: "Deployment" },
				{ sourceRelPath: "operations.mdx", targetRelPath: "sql/operations/index.mdx", title: "Operations" },
				{ sourceRelPath: "home.mdx", targetRelPath: "home.mdx", title: "Home" },
			],
		});

		const deployment = await readFile(join(contentDir, "guides/deployment/index.mdx"), "utf-8");
		expect(deployment).toMatch(/^---\nasIndexPage: true\n---\n/);
		expect(deployment).toContain("# Deployment");

		const operations = await readFile(join(contentDir, "sql/operations/index.mdx"), "utf-8");
		expect(operations).toMatch(/^---\ntitle: Ops\nasIndexPage: true\n---\n/);
		expect(operations).toContain("# Operations");

		// Source was an .mdx that didn't need renaming → frontmatter untouched.
		const home = await readFile(join(contentDir, "home.mdx"), "utf-8");
		expect(home).not.toContain("asIndexPage");
	});

	it("injects a top-level asIndexPage flag even when the frontmatter has a nested asIndexPage key", async () => {
		// Regression: the "already declared" check used to match
		// `^\s*asIndexPage\s*:` on any indentation, so a nested YAML key
		// (e.g. `things:\n  asIndexPage: true`) falsely registered as a
		// top-level declaration and the function skipped injection — the
		// resulting file then had no top-level flag, and Nextra v4 fell
		// back to its layout-conflict behaviour.
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();

		await writeFile(
			join(sourceRoot, "deployment.mdx"),
			"---\ntitle: Deployment\nthings:\n  asIndexPage: true\n---\n# Deployment\n",
			"utf-8",
		);

		await applyNavigationContentPlan(sourceRoot, contentDir, ["deployment.mdx"], {
			pages: [
				{ sourceRelPath: "deployment.mdx", targetRelPath: "guides/deployment/index.mdx", title: "Deployment" },
			],
		});

		const written = await readFile(join(contentDir, "guides/deployment/index.mdx"), "utf-8");
		// Top-level flag is present.
		expect(written).toMatch(/^---\n[\s\S]*^asIndexPage: true$/m);
		// And the original nested key was preserved.
		expect(written).toContain("things:\n  asIndexPage: true");
	});
});
