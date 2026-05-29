import { describe, expect, it } from "vitest";
import { buildNavigationContentPlan } from "./ContentPlanner.js";

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

// ─── validateNavigationPaths unit tests ──────────────────────────────────────

describe("validateNavigationPaths", () => {
	it("returns empty mismatches when every article's href resolves to a source file", async () => {
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		const mismatches = validateNavigationPaths(
			[
				{
					page: "Docs",
					root: "/docs",
					content: [{ article: "Intro", href: "intro" }],
				},
			],
			["docs/intro.md"],
		);
		expect(mismatches).toEqual([]);
	});

	it("returns a mismatch with a 'change href' suggestion when only one nearby file matches by basename suffix", async () => {
		// href "intro" doesn't resolve to a real file; the basename "intro" is
		// only a suffix of an existing file ("sub/myintro.md"), so the strict
		// `lastSegment` check in hasSourceMarkdown rejects but the broader
		// `endsWith` filter in checkArticle's candidate scan finds one match —
		// the suggestion proposes renaming to that file.
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		const mismatches = validateNavigationPaths(
			[
				{
					page: "Docs",
					root: "/docs",
					content: [{ article: "Intro", href: "intro" }],
				},
			],
			["sub/myintro.md"],
		);
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0].label).toBe("Intro");
		expect(mismatches[0].suggestion).toMatch(/Found "sub\/myintro\.md"/);
	});

	it("returns a 'Multiple matches' suggestion when more than one candidate file shares the basename", async () => {
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		const mismatches = validateNavigationPaths(
			[
				{
					page: "Docs",
					root: "/docs",
					content: [{ article: "Intro", href: "missing" }],
				},
			],
			["docs/a/missing.md", "docs/b/missing.md"],
		);
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0].suggestion).toMatch(/Multiple matches/);
	});

	it("returns a 'No matching file found' suggestion when no candidate exists at all", async () => {
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		const mismatches = validateNavigationPaths(
			[
				{
					page: "Docs",
					root: "/docs",
					content: [{ article: "Intro", href: "nope" }],
				},
			],
			["docs/intro.md"],
		);
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0].suggestion).toMatch(/No matching file found/);
	});

	it("skips external articles and menu / openapi pages", async () => {
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		const mismatches = validateNavigationPaths(
			[
				{ page: "API", openapi: "./api/openapi.json" },
				{
					page: "Community",
					type: "menu",
					items: [{ label: "Discord", url: "https://discord.example" }],
				},
				{
					page: "Docs",
					root: "/docs",
					content: [
						{ article: "External", href: "https://example.com", type: "external" },
						{ article: "Intro", href: "intro" },
					],
				},
			],
			["docs/intro.md"],
		);
		expect(mismatches).toEqual([]);
	});

	it("works in simple mode (no pages)", async () => {
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		const mismatches = validateNavigationPaths([{ article: "Intro", href: "intro" }], ["intro.md"]);
		expect(mismatches).toEqual([]);
	});

	it("descends into article.articles[] children", async () => {
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		const mismatches = validateNavigationPaths(
			[
				{
					page: "Docs",
					root: "/docs",
					content: [
						{
							article: "Deployment",
							href: "deployment",
							articles: [{ article: "Docker", href: "deployment/missing-child" }],
						},
					],
				},
			],
			["docs/deployment.md"],
		);
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0].label).toBe("Docker");
	});

	it("returns empty mismatches for an empty navigation", async () => {
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		expect(validateNavigationPaths([], ["whatever.md"])).toEqual([]);
	});
});

// ─── buildNavigationContentPlan — edge cases ─────────────────────────────────

describe("buildNavigationContentPlan (edge cases)", () => {
	it("returns an empty plan for an empty navigation array", async () => {
		const { buildNavigationContentPlan } = await import("./ContentPlanner.js");
		expect(buildNavigationContentPlan([], ["intro.md"])).toEqual({ pages: [] });
	});

	it("supports simple mode (groups/articles at the root, no page wrapper)", async () => {
		const { buildNavigationContentPlan } = await import("./ContentPlanner.js");
		const plan = buildNavigationContentPlan(
			[
				{ article: "Intro", href: "intro" },
				{ group: "Guides", content: [{ article: "Deploy", href: "deploy" }] },
			],
			["intro.md", "deploy.md"],
		);
		expect(plan.pages).toEqual([
			{ sourceRelPath: "intro.md", targetRelPath: "intro.md", title: "Intro" },
			{ sourceRelPath: "deploy.md", targetRelPath: "deploy.md", title: "Deploy" },
		]);
	});

	it("skips openapi-only pages and menu pages (planner only handles markdown content)", async () => {
		const { buildNavigationContentPlan } = await import("./ContentPlanner.js");
		const plan = buildNavigationContentPlan(
			[
				{ page: "API", openapi: "./api/openapi.json" },
				{ page: "Community", type: "menu", items: [{ label: "Discord", url: "https://discord.example" }] },
				{
					page: "Docs",
					root: "/docs",
					content: [{ article: "Intro", href: "intro" }],
				},
			],
			["docs/intro.md"],
		);
		expect(plan.pages).toEqual([
			{ sourceRelPath: "docs/intro.md", targetRelPath: "docs/intro.md", title: "Intro" },
		]);
	});
});

// ─── validateNavigationPaths — group and folder-only article paths ───────────

describe("validateNavigationPaths (group + folder-only paths)", () => {
	it("walks into group.content and uses the group's resolved root for href validation", async () => {
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		const mismatches = validateNavigationPaths(
			[
				{
					page: "Docs",
					root: "/docs",
					content: [
						{
							group: "Guides",
							root: "guides",
							content: [{ article: "Intro", href: "intro" }],
						},
					],
				},
			],
			["docs/guides/intro.md"],
		);
		expect(mismatches).toEqual([]);
	});

	it("treats an article with articles[] but no source file as a folder-only entry (still validates children)", async () => {
		// The parent "deployment" has no source file but has children — treated
		// as a sidebar-only collapsible folder. Its child (with a missing source)
		// still produces a mismatch.
		const { validateNavigationPaths } = await import("./ContentPlanner.js");
		const mismatches = validateNavigationPaths(
			[
				{
					page: "Docs",
					root: "/docs",
					content: [
						{
							article: "Deployment",
							href: "deployment",
							articles: [{ article: "Docker", href: "docker-missing" }],
						},
					],
				},
			],
			["docs/deployment/docker.md"], // parent has no file; child's path is wrong
		);
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0].label).toBe("Docker");
	});
});

// ─── buildNavigationContentPlan — externals and ambiguous matches ────────────

describe("buildNavigationContentPlan (externals + ambiguity)", () => {
	it("skips external articles when building the plan (they have no source file)", async () => {
		const { buildNavigationContentPlan } = await import("./ContentPlanner.js");
		const plan = buildNavigationContentPlan(
			[
				{
					page: "Docs",
					root: "/docs",
					content: [
						{ article: "External", href: "https://example.com", type: "external" },
						{ article: "Intro", href: "intro" },
					],
				},
			],
			["docs/intro.md"],
		);
		expect(plan.pages).toEqual([
			{ sourceRelPath: "docs/intro.md", targetRelPath: "docs/intro.md", title: "Intro" },
		]);
	});

	it("silently skips an article with no source file and no children (e.g. an OpenAPI-served route)", async () => {
		const { buildNavigationContentPlan } = await import("./ContentPlanner.js");
		const plan = buildNavigationContentPlan(
			[
				{
					page: "Docs",
					root: "/docs",
					content: [
						{ article: "Auto", href: "auto" }, // no matching file
						{ article: "Intro", href: "intro" },
					],
				},
			],
			["docs/intro.md"],
		);
		expect(plan.pages).toEqual([
			{ sourceRelPath: "docs/intro.md", targetRelPath: "docs/intro.md", title: "Intro" },
		]);
	});
});
