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
	it("maps navigation pages and groups onto target markdown paths", () => {
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
				targetRelPath: "docs/guides/intro.mdx",
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

	it("uses group sourceRoot when the physical source subtree differs from the logical group root", () => {
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
				targetRelPath: "docs/guides/deploy.md",
				title: "Deploy",
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
});
