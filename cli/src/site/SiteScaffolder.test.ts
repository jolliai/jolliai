/**
 * SiteScaffolder tests
 *
 * Tests scaffolding logic: file creation for themes/templates, force/overwrite
 * behavior, variable substitution, and generated content correctness.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readdirSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	mkdirSync: mocks.mkdirSync,
	readdirSync: mocks.readdirSync,
	writeFileSync: mocks.writeFileSync,
}));

import { scaffold } from "./SiteScaffolder.js";
import { substituteVars } from "./templateUtils.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writtenFiles(): string[] {
	return mocks.writeFileSync.mock.calls.map((c: unknown[]) => c[0] as string);
}

function writtenContent(filename: string): string | undefined {
	const call = mocks.writeFileSync.mock.calls.find((c: unknown[]) => (c[0] as string).endsWith(filename));
	return call?.[1] as string | undefined;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("substituteVars", () => {
	it("replaces single variable", () => {
		expect(substituteVars("Hello {{NAME}}", { NAME: "World" })).toBe("Hello World");
	});

	it("replaces multiple occurrences", () => {
		expect(substituteVars("{{X}} and {{X}}", { X: "A" })).toBe("A and A");
	});

	it("replaces multiple variables", () => {
		expect(substituteVars("{{A}} {{B}}", { A: "1", B: "2" })).toBe("1 2");
	});

	it("leaves content unchanged when no placeholders", () => {
		expect(substituteVars("no vars here", { X: "A" })).toBe("no vars here");
	});
});

describe("SiteScaffolder", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.existsSync.mockReturnValue(false);
	});

	describe("docs theme — minimal template", () => {
		it("creates expected files", () => {
			const result = scaffold({
				targetDir: "/tmp/my-docs",
				theme: "docs",
				template: "minimal",
				name: "My Docs",
				force: false,
			});

			expect(result.filesWritten).toBeGreaterThan(8);
			expect(result.targetDir).toBe("/tmp/my-docs");

			const files = writtenFiles();
			expect(files).toContainEqual(expect.stringContaining("package.json"));
			expect(files).toContainEqual(expect.stringContaining("next.config.mjs"));
			expect(files).toContainEqual(expect.stringContaining("tsconfig.json"));
			expect(files).toContainEqual(expect.stringContaining(".gitignore"));
			expect(files).toContainEqual(expect.stringContaining("page.tsx"));
			expect(files).toContainEqual(expect.stringContaining("mdx-components.tsx"));
			expect(files).toContainEqual(expect.stringContaining("layout.tsx"));
			expect(files).toContainEqual(expect.stringContaining("index.mdx"));
			expect(files).toContainEqual(expect.stringContaining("_meta.ts"));
		});

		it("generates package.json with nextra-theme-docs and pagefind", () => {
			scaffold({ targetDir: "/tmp/docs", theme: "docs", template: "minimal", name: "test", force: false });

			const content = writtenContent("package.json");
			expect(content).toBeDefined();
			const pkg = JSON.parse(content as string);
			expect(pkg.dependencies["nextra-theme-docs"]).toBeDefined();
			expect(pkg.dependencies["nextra-theme-blog"]).toBeUndefined();
			expect(pkg.dependencies["next-themes"]).toBeUndefined();
			expect(pkg.devDependencies.pagefind).toBeDefined();
			expect(pkg.scripts.build).toContain("pagefind");
		});

		it("substitutes project name in layout", () => {
			scaffold({ targetDir: "/tmp/docs", theme: "docs", template: "minimal", name: "Acme Docs", force: false });

			const layout = writtenContent("layout.tsx");
			expect(layout).toContain("Acme Docs");
			expect(layout).not.toContain("{{PROJECT_NAME}}");
		});

		it("substitutes project name in index page", () => {
			scaffold({ targetDir: "/tmp/docs", theme: "docs", template: "minimal", name: "Acme Docs", force: false });

			const index = writtenContent("index.mdx");
			expect(index).toContain("Acme Docs");
			expect(index).not.toContain("{{PROJECT_NAME}}");
		});
	});

	describe("docs theme — starter template", () => {
		it("creates expected files including OpenAPI", () => {
			const result = scaffold({
				targetDir: "/tmp/my-starter",
				theme: "docs",
				template: "starter",
				name: "My API",
				force: false,
			});

			expect(result.filesWritten).toBeGreaterThan(15);

			const files = writtenFiles();
			expect(files).toContainEqual(expect.stringContaining("favicon.svg"));
			expect(files).toContainEqual(expect.stringContaining("getting-started.mdx"));
			expect(files).toContainEqual(expect.stringContaining("customization.mdx"));
			expect(files).toContainEqual(expect.stringContaining("deployment.mdx"));
			expect(files).toContainEqual(expect.stringContaining("api-docs-petstore.json"));
			expect(files).toContainEqual(expect.stringContaining("api-docs-petstore.html"));
			expect(files).toContainEqual(expect.stringContaining("ApiReference.tsx"));
		});

		it("generates package.json with next-themes dependency", () => {
			scaffold({ targetDir: "/tmp/starter", theme: "docs", template: "starter", name: "test", force: false });

			const content = writtenContent("package.json");
			const pkg = JSON.parse(content as string);
			expect(pkg.dependencies["next-themes"]).toBeDefined();
		});

		it("generates valid OpenAPI spec", () => {
			scaffold({ targetDir: "/tmp/starter", theme: "docs", template: "starter", name: "test", force: false });

			const spec = writtenContent("api-docs-petstore.json");
			expect(spec).toBeDefined();
			const parsed = JSON.parse(spec as string);
			expect(parsed.openapi).toBe("3.0.3");
			expect(parsed.paths["/pets"]).toBeDefined();
		});

		it("generates _meta with best-practice navigation", () => {
			scaffold({ targetDir: "/tmp/starter", theme: "docs", template: "starter", name: "test", force: false });

			const meta = writtenContent("_meta.ts");
			expect(meta).toContain("API Reference");
			expect(meta).toContain("separator");
			expect(meta).toContain("GitHub");
		});

		it("substitutes project name in starter content", () => {
			scaffold({
				targetDir: "/tmp/starter",
				theme: "docs",
				template: "starter",
				name: "Acme API",
				force: false,
			});

			const index = writtenContent("index.mdx");
			expect(index).toContain("Acme API");
			expect(index).not.toContain("{{PROJECT_NAME}}");

			const guide = writtenContent("getting-started.mdx");
			expect(guide).toContain("Acme API");
		});
	});

	describe("blog theme", () => {
		it("creates expected files", () => {
			const result = scaffold({
				targetDir: "/tmp/my-blog",
				theme: "blog",
				template: "minimal",
				name: "My Blog",
				force: false,
			});

			expect(result.filesWritten).toBeGreaterThan(8);

			const files = writtenFiles();
			expect(files).toContainEqual(expect.stringContaining("package.json"));
			expect(files).toContainEqual(expect.stringContaining("layout.tsx"));
			expect(files).toContainEqual(expect.stringContaining("page.mdx"));
		});

		it("generates package.json with nextra-theme-blog", () => {
			scaffold({ targetDir: "/tmp/blog", theme: "blog", template: "minimal", name: "test", force: false });

			const content = writtenContent("package.json");
			const pkg = JSON.parse(content as string);
			expect(pkg.dependencies["nextra-theme-blog"]).toBeDefined();
			expect(pkg.dependencies["nextra-theme-docs"]).toBeUndefined();
		});

		it("substitutes date in blog post", () => {
			scaffold({ targetDir: "/tmp/blog", theme: "blog", template: "minimal", name: "test", force: false });

			const helloPost = mocks.writeFileSync.mock.calls.find((c: unknown[]) =>
				(c[0] as string).endsWith("hello-world/page.mdx"),
			);
			expect(helloPost).toBeDefined();
			expect(helloPost?.[1]).toMatch(/date: \d{4}-\d{2}-\d{2}/);
			expect(helloPost?.[1]).not.toContain("{{TODAY_DATE}}");
		});

		it("substitutes project name in blog layout", () => {
			scaffold({ targetDir: "/tmp/blog", theme: "blog", template: "minimal", name: "Acme Blog", force: false });

			const layout = writtenContent("layout.tsx");
			expect(layout).toContain("Acme Blog");
			expect(layout).not.toContain("{{PROJECT_NAME}}");
		});
	});

	describe("directory validation", () => {
		it("throws when directory is non-empty and force is false", () => {
			mocks.existsSync.mockReturnValue(true);
			mocks.readdirSync.mockReturnValue(["package.json"]);

			expect(() =>
				scaffold({
					targetDir: "/tmp/existing",
					theme: "docs",
					template: "minimal",
					name: "test",
					force: false,
				}),
			).toThrow('Directory "/tmp/existing" is not empty. Use --force to overwrite.');
		});

		it("proceeds when directory is non-empty and force is true", () => {
			mocks.existsSync.mockReturnValue(true);
			mocks.readdirSync.mockReturnValue(["package.json"]);

			const result = scaffold({
				targetDir: "/tmp/existing",
				theme: "docs",
				template: "minimal",
				name: "test",
				force: true,
			});
			expect(result.filesWritten).toBeGreaterThan(0);
		});

		it("proceeds when directory exists but is empty", () => {
			mocks.existsSync.mockReturnValue(true);
			mocks.readdirSync.mockReturnValue([]);

			const result = scaffold({
				targetDir: "/tmp/empty",
				theme: "docs",
				template: "minimal",
				name: "test",
				force: false,
			});
			expect(result.filesWritten).toBeGreaterThan(0);
		});

		it("proceeds when directory does not exist", () => {
			mocks.existsSync.mockReturnValue(false);

			const result = scaffold({
				targetDir: "/tmp/new",
				theme: "docs",
				template: "minimal",
				name: "test",
				force: false,
			});
			expect(result.filesWritten).toBeGreaterThan(0);
		});
	});

	describe("shared templates", () => {
		it("generates next.config.mjs with format detect", () => {
			scaffold({ targetDir: "/tmp/docs", theme: "docs", template: "minimal", name: "test", force: false });

			const config = writtenContent("next.config.mjs");
			expect(config).toContain('import nextra from "nextra"');
			expect(config).toContain('"detect"');
		});

		it("includes .gitignore with _pagefind exclusion", () => {
			scaffold({ targetDir: "/tmp/docs", theme: "docs", template: "minimal", name: "test", force: false });

			const gitignore = writtenContent(".gitignore");
			expect(gitignore).toContain("_pagefind");
		});

		it("creates directories recursively", () => {
			scaffold({ targetDir: "/tmp/docs", theme: "docs", template: "minimal", name: "test", force: false });

			expect(mocks.mkdirSync).toHaveBeenCalled();
			const calls = mocks.mkdirSync.mock.calls;
			for (const call of calls) {
				expect(call[1]).toEqual({ recursive: true });
			}
		});
	});
});
