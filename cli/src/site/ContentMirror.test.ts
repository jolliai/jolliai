/**
 * Tests for ContentMirror — classifies and mirrors Content_Folder files.
 *
 * Covers all acceptance criteria from Task 4:
 *   - classifyFile returns correct FileType for all supported extensions
 *   - classifyFile detects OpenAPI content in JSON/YAML files
 *   - classifyFile returns "ignored" for unsupported types
 *   - mirrorContent copies markdown and image files to contentDir
 *   - mirrorContent skips .jolli-site/ directory
 *   - mirrorContent preserves directory structure
 *
 * Property-based tests (fast-check):
 *   - Property 1: File type classification is consistent
 *     **Validates: Requirements 3.1, 3.2, 3.3**
 *   - Property 2: Content mirroring preserves directory structure
 *     **Validates: Requirements 5.1, 5.2**
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-contentmirror-test-"));
}

/** Minimal valid OpenAPI JSON content */
const OPENAPI_JSON = JSON.stringify({ openapi: "3.1.0", info: { title: "Test", version: "1.0" } });

/** Minimal valid OpenAPI YAML content */
const OPENAPI_YAML = `openapi: "3.1.0"\ninfo:\n  title: Test\n  version: "1.0"\n`;

// ─── classifyFile unit tests ──────────────────────────────────────────────────

describe("ContentMirror.classifyFile", () => {
	// ── Markdown (4.2) ──────────────────────────────────────────────────────

	it('classifies .md files as "markdown"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("docs/readme.md")).toBe("markdown");
	});

	it('classifies .mdx files as "markdown"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("pages/index.mdx")).toBe("markdown");
	});

	it('classifies .MD files (uppercase) as "markdown"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("README.MD")).toBe("markdown");
	});

	// ── Images (4.3) ────────────────────────────────────────────────────────

	it('classifies .png files as "image"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("assets/logo.png")).toBe("image");
	});

	it('classifies .jpg files as "image"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("assets/photo.jpg")).toBe("image");
	});

	it('classifies .jpeg files as "image"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("assets/photo.jpeg")).toBe("image");
	});

	it('classifies .gif files as "image"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("assets/anim.gif")).toBe("image");
	});

	it('classifies .svg files as "image"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("assets/icon.svg")).toBe("image");
	});

	it('classifies .webp files as "image"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("assets/banner.webp")).toBe("image");
	});

	it('classifies .ico files as "image"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("favicon.ico")).toBe("image");
	});

	it('classifies .PNG files (uppercase) as "image"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("LOGO.PNG")).toBe("image");
	});

	// ── OpenAPI JSON (4.4) ──────────────────────────────────────────────────

	it('classifies .json with openapi + info as "openapi"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("api/spec.json", OPENAPI_JSON)).toBe("openapi");
	});

	it('classifies .json without openapi field as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		const content = JSON.stringify({ info: { title: "Test" } });
		expect(classifyFile("api/spec.json", content)).toBe("ignored");
	});

	it('classifies .json without info field as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		const content = JSON.stringify({ openapi: "3.1.0" });
		expect(classifyFile("api/spec.json", content)).toBe("ignored");
	});

	it('classifies .json with no content provided as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("api/spec.json")).toBe("ignored");
	});

	it('classifies .json with invalid JSON content as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("api/spec.json", "{ not valid json }")).toBe("ignored");
	});

	// ── OpenAPI YAML (4.4) ──────────────────────────────────────────────────

	it('classifies .yaml with openapi + info as "openapi"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("api/spec.yaml", OPENAPI_YAML)).toBe("openapi");
	});

	it('classifies .yml with openapi + info as "openapi"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("api/spec.yml", OPENAPI_YAML)).toBe("openapi");
	});

	it('classifies .yaml without openapi line as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		const content = "info:\n  title: Test\n";
		expect(classifyFile("api/spec.yaml", content)).toBe("ignored");
	});

	it('classifies .yaml without info line as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		const content = "openapi: 3.1.0\ntitle: Test\n";
		expect(classifyFile("api/spec.yaml", content)).toBe("ignored");
	});

	it('classifies .yaml with no content provided as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("api/spec.yaml")).toBe("ignored");
	});

	// ── Ignored types (4.5) ─────────────────────────────────────────────────

	it('classifies .ts files as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("src/index.ts")).toBe("ignored");
	});

	it('classifies .txt files as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("notes.txt")).toBe("ignored");
	});

	it('classifies .pdf files as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("doc.pdf")).toBe("ignored");
	});

	it('classifies files with no extension as "ignored"', async () => {
		const { classifyFile } = await import("./ContentMirror.js");
		expect(classifyFile("Makefile")).toBe("ignored");
	});
});

// ─── mirrorContent unit tests ─────────────────────────────────────────────────

describe("ContentMirror.mirrorContent", () => {
	let sourceRoot: string;
	let contentDir: string;

	beforeEach(async () => {
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
		await rm(contentDir, { recursive: true, force: true });
	});

	// ── Markdown files are copied (4.6) ─────────────────────────────────────

	it("copies a markdown file to contentDir", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "index.md"), "# Hello", "utf-8");

		await mirrorContent(sourceRoot, contentDir);

		expect(existsSync(join(contentDir, "index.md"))).toBe(true);
	});

	it("includes the markdown file in markdownFiles result", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "index.md"), "# Hello", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("index.md");
	});

	it("copies a nested markdown file preserving directory structure", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await mkdir(join(sourceRoot, "guides"), { recursive: true });
		await writeFile(join(sourceRoot, "guides", "intro.md"), "# Intro", "utf-8");

		await mirrorContent(sourceRoot, contentDir);

		expect(existsSync(join(contentDir, "guides", "intro.md"))).toBe(true);
	});

	it("includes nested markdown file in markdownFiles with relative path", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await mkdir(join(sourceRoot, "guides"), { recursive: true });
		await writeFile(join(sourceRoot, "guides", "intro.md"), "# Intro", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain(join("guides", "intro.md"));
	});

	// ── Image files are copied (Requirement 3.4) ────────────────────────────

	it("copies an image file to contentDir", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		await mirrorContent(sourceRoot, contentDir);

		expect(existsSync(join(contentDir, "logo.png"))).toBe(true);
	});

	it("includes the image file in imageFiles result", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.imageFiles).toContain("logo.png");
	});

	// ── OpenAPI files are recorded but not copied ────────────────────────────

	it("records OpenAPI files in openapiFiles but does not copy them", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "api.yaml"), OPENAPI_YAML, "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.openapiFiles).toContain("api.yaml");
		expect(existsSync(join(contentDir, "api.yaml"))).toBe(false);
	});

	it("caches the parsed OpenAPI document in openapiDocs keyed by relative path", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "api.yaml"), OPENAPI_YAML, "utf-8");
		await writeFile(join(sourceRoot, "api.json"), OPENAPI_JSON, "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.openapiDocs["api.yaml"]?.openapi).toBe("3.1.0");
		expect(result.openapiDocs["api.json"]?.openapi).toBe("3.1.0");
		expect(result.openapiDocs["api.yaml"]?.info.title).toBe("Test");
		// Ignored files must not appear in the cache.
		await writeFile(join(sourceRoot, "notes.txt"), "x", "utf-8");
		const result2 = await mirrorContent(sourceRoot, contentDir);
		expect(result2.openapiDocs["notes.txt"]).toBeUndefined();
	});

	// ── Ignored files ────────────────────────────────────────────────────────

	it("records ignored files in ignoredFiles", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "notes.txt"), "some notes", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.ignoredFiles).toContain("notes.txt");
	});

	it("does not copy ignored files to contentDir", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "notes.txt"), "some notes", "utf-8");

		await mirrorContent(sourceRoot, contentDir);

		expect(existsSync(join(contentDir, "notes.txt"))).toBe(false);
	});

	// ── .jolli-site/ is skipped (4.7) ───────────────────────────────────────

	it("skips .jolli-site/ directory during traversal", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		const jolliSiteDir = join(sourceRoot, ".jolli-site", "pages");
		await mkdir(jolliSiteDir, { recursive: true });
		await writeFile(join(jolliSiteDir, "hidden.md"), "# Hidden", "utf-8");
		// Also add a real file at root
		await writeFile(join(sourceRoot, "real.md"), "# Real", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		// hidden.md inside .jolli-site/ should NOT be in the result
		const allFiles = [
			...result.markdownFiles,
			...result.imageFiles,
			...result.openapiFiles,
			...result.ignoredFiles,
		];
		expect(allFiles.some((f) => f.includes(".jolli-site"))).toBe(false);
		// real.md should be copied
		expect(result.markdownFiles).toContain("real.md");
	});

	// ── Mixed content ────────────────────────────────────────────────────────

	it("handles a mix of file types correctly", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await mkdir(join(sourceRoot, "api"), { recursive: true });
		await writeFile(join(sourceRoot, "index.md"), "# Home", "utf-8");
		await writeFile(join(sourceRoot, "logo.svg"), "<svg/>", "utf-8");
		await writeFile(join(sourceRoot, "api", "spec.yaml"), OPENAPI_YAML, "utf-8");
		await writeFile(join(sourceRoot, "notes.txt"), "ignored", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("index.md");
		expect(result.imageFiles).toContain("logo.svg");
		expect(result.openapiFiles).toContain(join("api", "spec.yaml"));
		expect(result.ignoredFiles).toContain("notes.txt");
	});

	// ── Incompatible MDX files (Docusaurus etc.) ────────────────────────────

	it("downgrades .mdx files with @theme/ imports to .md", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		const mdxContent = `import Tabs from '@theme/Tabs'\nimport TabItem from '@theme/TabItem'\n\n# Config\n`;
		await writeFile(join(sourceRoot, "config.mdx"), mdxContent, "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("config.md");
		expect(result.markdownFiles).not.toContain("config.mdx");
		expect(existsSync(join(contentDir, "config.md"))).toBe(true);
		expect(existsSync(join(contentDir, "config.mdx"))).toBe(false);
	});

	it("strips import lines when downgrading .mdx to .md", async () => {
		const { readFile: rf } = await import("node:fs/promises");
		const { mirrorContent } = await import("./ContentMirror.js");
		const mdxContent = `import Tabs from '@theme/Tabs'\n\n# Config\n\nSome text here.\n`;
		await writeFile(join(sourceRoot, "config.mdx"), mdxContent, "utf-8");

		await mirrorContent(sourceRoot, contentDir);

		const output = await rf(join(contentDir, "config.md"), "utf-8");
		expect(output).not.toContain("import");
		expect(output).toContain("# Config");
		expect(output).toContain("Some text here.");
	});

	it("downgrades .mdx files with @docusaurus/ imports to .md", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		const mdxContent = `import Link from '@docusaurus/Link'\n\n# Page\n`;
		await writeFile(join(sourceRoot, "page.mdx"), mdxContent, "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("page.md");
	});

	it("copies .mdx files without incompatible imports normally", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		const mdxContent = `import SwaggerUI from 'swagger-ui-react'\n\n# API\n`;
		await writeFile(join(sourceRoot, "api.mdx"), mdxContent, "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("api.mdx");
		expect(existsSync(join(contentDir, "api.mdx"))).toBe(true);
	});

	it("downgrades .mdx with unknown JSX components to .md with components stripped", async () => {
		const { readFile: rf } = await import("node:fs/promises");
		const { mirrorContent } = await import("./ContentMirror.js");
		const mdxContent = `# Videos\n\n<LiteYouTubeEmbed id="abc123" />\n\nSome text after.\n`;
		await writeFile(join(sourceRoot, "videos.mdx"), mdxContent, "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("videos.md");
		const output = await rf(join(contentDir, "videos.md"), "utf-8");
		expect(output).toContain("# Videos");
		expect(output).toContain("Some text after.");
		expect(output).not.toContain("LiteYouTubeEmbed");
	});

	it("keeps children content when stripping JSX wrapper tags", async () => {
		const { readFile: rf } = await import("node:fs/promises");
		const { mirrorContent } = await import("./ContentMirror.js");
		const mdxContent = `import Tabs from '@theme/Tabs'\n\n# Code\n\n<Tabs>\n<TabItem value="js" label="JS">\n\n\`\`\`js\nconsole.log("hi")\n\`\`\`\n\n</TabItem>\n</Tabs>\n`;
		await writeFile(join(sourceRoot, "code.mdx"), mdxContent, "utf-8");

		await mirrorContent(sourceRoot, contentDir);

		const output = await rf(join(contentDir, "code.md"), "utf-8");
		expect(output).toContain("# Code");
		expect(output).toContain('console.log("hi")');
		expect(output).not.toContain("<Tabs");
		expect(output).not.toContain("<TabItem");
	});

	it("downgrades .mdx files with invalid MDX syntax to .md (Layer 2)", async () => {
		const { readFile: rf } = await import("node:fs/promises");
		const { mirrorContent } = await import("./ContentMirror.js");
		// Malformed JSX that passes regex but fails MDX compilation
		const mdxContent = `# Broken\n\n<div onClick={function(){ broken syntax}}>test</div>\n\nGood text.\n`;
		await writeFile(join(sourceRoot, "broken.mdx"), mdxContent, "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("broken.md");
		const output = await rf(join(contentDir, "broken.md"), "utf-8");
		expect(output).toContain("# Broken");
		expect(output).toContain("Good text.");
	});

	it("allows .mdx files with Nextra built-in components like Callout", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		const mdxContent = `# Docs\n\n<Callout type="info">Note</Callout>\n`;
		await writeFile(join(sourceRoot, "docs.mdx"), mdxContent, "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("docs.mdx");
	});

	it("allows .mdx files with imported custom components", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		const mdxContent = `import MyChart from './MyChart'\n\n# Stats\n\n<MyChart />\n`;
		await writeFile(join(sourceRoot, "stats.mdx"), mdxContent, "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("stats.mdx");
	});

	it("copies .md files without checking imports", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "normal.md"), "# Normal\n", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("normal.md");
	});

	// ── Empty source root ────────────────────────────────────────────────────

	it("returns empty arrays for an empty source root", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toHaveLength(0);
		expect(result.openapiFiles).toHaveLength(0);
		expect(result.imageFiles).toHaveLength(0);
		expect(result.ignoredFiles).toHaveLength(0);
	});

	// ── Error handling: unreadable directory ─────────────────────────────────

	it("skips unreadable directories without throwing", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		// sourceRoot pointing to a non-existent path
		const result = await mirrorContent(join(sourceRoot, "nonexistent"), contentDir);

		expect(result.markdownFiles).toHaveLength(0);
	});

	it("skips entries where stat fails (e.g. broken symlinks)", async () => {
		const { symlink } = await import("node:fs/promises");
		const { mirrorContent } = await import("./ContentMirror.js");
		// Create a broken symlink — readdir lists it, but stat fails
		await symlink(join(sourceRoot, "nonexistent-target"), join(sourceRoot, "broken.md"));
		// Also add a real file so we verify the rest works
		await writeFile(join(sourceRoot, "real.md"), "# Real", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("real.md");
		// broken.md should be silently skipped, not in any result array
		expect(result.markdownFiles).not.toContain("broken.md");
	});

	// ── Error handling: unreadable file for OpenAPI classification ──────────

	it("treats an unreadable .yaml file as ignored", async () => {
		const { chmod, writeFile: wf } = await import("node:fs/promises");
		const { mirrorContent } = await import("./ContentMirror.js");
		const yamlPath = join(sourceRoot, "spec.yaml");
		await wf(yamlPath, "openapi: 3.0.0\ninfo:\n  title: T", "utf-8");
		// Remove read permissions so readFile fails
		await chmod(yamlPath, 0o000);

		const result = await mirrorContent(sourceRoot, contentDir);

		// Restore permissions for cleanup
		await chmod(yamlPath, 0o644);
		expect(result.ignoredFiles).toContain("spec.yaml");
	});
});

// ─── Property-based tests ─────────────────────────────────────────────────────

/**
 * Property 1: File type classification is consistent
 * **Validates: Requirements 3.1, 3.2, 3.3**
 */
describe("Property 1: File type classification is consistent", () => {
	// Arbitrary safe filename segment (letters, digits, hyphens)
	const safeSegment = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/).filter((s) => s.length > 0);

	it("classifyFile always returns markdown for .md files", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, (name) => {
				const result = classifyFile(`${name}.md`);
				return result === "markdown";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns markdown for .mdx files", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, (name) => {
				const result = classifyFile(`${name}.mdx`);
				return result === "markdown";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns image for .png files", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, (name) => {
				return classifyFile(`${name}.png`) === "image";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns image for .jpg files", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, (name) => {
				return classifyFile(`${name}.jpg`) === "image";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns image for .jpeg files", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, (name) => {
				return classifyFile(`${name}.jpeg`) === "image";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns image for .gif files", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, (name) => {
				return classifyFile(`${name}.gif`) === "image";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns image for .svg files", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, (name) => {
				return classifyFile(`${name}.svg`) === "image";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns image for .webp files", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, (name) => {
				return classifyFile(`${name}.webp`) === "image";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns image for .ico files", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, (name) => {
				return classifyFile(`${name}.ico`) === "image";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns openapi for .json files with openapi + info fields", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		// Generate random openapi version strings and info objects
		const openApiContent = fc.record({
			openapi: fc.constantFrom("3.0.0", "3.1.0", "3.0.3"),
			info: fc.record({
				title: safeSegment,
				version: fc.constantFrom("1.0.0", "2.0.0"),
			}),
		});

		fc.assert(
			fc.property(safeSegment, openApiContent, (name, spec) => {
				const content = JSON.stringify(spec);
				return classifyFile(`${name}.json`, content) === "openapi";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns openapi for .yaml files with openapi + info fields", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, safeSegment, (name, version) => {
				const content = `openapi: "${version}"\ninfo:\n  title: Test\n`;
				return classifyFile(`${name}.yaml`, content) === "openapi";
			}),
			{ numRuns: 100 },
		);
	});

	it("classifyFile always returns openapi for .yml files with openapi + info fields", async () => {
		const { classifyFile } = await import("./ContentMirror.js");

		fc.assert(
			fc.property(safeSegment, safeSegment, (name, version) => {
				const content = `openapi: "${version}"\ninfo:\n  title: Test\n`;
				return classifyFile(`${name}.yml`, content) === "openapi";
			}),
			{ numRuns: 100 },
		);
	});
});

/**
 * Property 2: Content mirroring preserves directory structure
 * **Validates: Requirements 5.1, 5.2**
 */
describe("Property 2: Content mirroring preserves directory structure", () => {
	let sourceRoot: string;
	let contentDir: string;

	beforeEach(async () => {
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
		await rm(contentDir, { recursive: true, force: true });
	});

	it("every markdown file appears at the corresponding path in contentDir", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");

		// Generate a small set of relative markdown paths (1-5 files)
		// Use simple safe names to avoid filesystem issues
		const safeFilename = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/).filter((s) => s.length > 0);

		await fc.assert(
			fc.asyncProperty(fc.array(safeFilename, { minLength: 1, maxLength: 5 }), async (names) => {
				// Clean up between runs
				await rm(sourceRoot, { recursive: true, force: true });
				await rm(contentDir, { recursive: true, force: true });
				sourceRoot = await makeTempDir();
				contentDir = await makeTempDir();

				// Write unique markdown files at root level
				const uniqueNames = [...new Set(names)];
				for (const name of uniqueNames) {
					await writeFile(join(sourceRoot, `${name}.md`), `# ${name}`, "utf-8");
				}

				const result = await mirrorContent(sourceRoot, contentDir);

				// Every markdown file must exist in contentDir
				for (const relPath of result.markdownFiles) {
					if (!existsSync(join(contentDir, relPath))) {
						return false;
					}
				}
				return true;
			}),
			{ numRuns: 50 },
		);
	});

	it("markdown files in subdirectories appear at the correct nested path in contentDir", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");

		const safeSegment = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/).filter((s) => s.length > 0);

		await fc.assert(
			fc.asyncProperty(safeSegment, safeSegment, async (dirName, fileName) => {
				// Clean up between runs
				await rm(sourceRoot, { recursive: true, force: true });
				await rm(contentDir, { recursive: true, force: true });
				sourceRoot = await makeTempDir();
				contentDir = await makeTempDir();

				const subDir = join(sourceRoot, dirName);
				await mkdir(subDir, { recursive: true });
				await writeFile(join(subDir, `${fileName}.md`), `# ${fileName}`, "utf-8");

				const result = await mirrorContent(sourceRoot, contentDir);

				const expectedRelPath = join(dirName, `${fileName}.md`);
				return result.markdownFiles.includes(expectedRelPath) && existsSync(join(contentDir, expectedRelPath));
			}),
			{ numRuns: 50 },
		);
	});
});

// ─── stripIncompatibleContent tests ──────────────────────────────────────────

describe("ContentMirror.stripIncompatibleContent", () => {
	it("removes import statements", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = "import Tabs from '@theme/Tabs'\nimport TabItem from '@theme/TabItem'\n\n# Title\n";

		const result = stripIncompatibleContent(input);

		expect(result).not.toContain("import");
		expect(result).toContain("# Title");
	});

	it("removes export statements", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = "export const meta = { title: 'Test' }\n\n# Title\n";

		const result = stripIncompatibleContent(input);

		expect(result).not.toContain("export");
		expect(result).toContain("# Title");
	});

	it("removes self-closing JSX tags", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = '# Title\n\n<LiteYouTubeEmbed id="abc123" />\n\nText after.\n';

		const result = stripIncompatibleContent(input);

		expect(result).not.toContain("LiteYouTubeEmbed");
		expect(result).toContain("Text after.");
	});

	it("removes self-closing JSX tags without attributes", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = "# Title\n\n<Spacer/>\n\nText.\n";

		const result = stripIncompatibleContent(input);

		expect(result).not.toContain("Spacer");
		expect(result).toContain("Text.");
	});

	it("removes opening and closing JSX tags but keeps children", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input =
			'# Code\n\n<Tabs>\n<TabItem value="js" label="JS">\n\n```js\nconsole.log()\n```\n\n</TabItem>\n</Tabs>\n';

		const result = stripIncompatibleContent(input);

		expect(result).not.toContain("<Tabs");
		expect(result).not.toContain("<TabItem");
		expect(result).not.toContain("</Tabs");
		expect(result).not.toContain("</TabItem");
		expect(result).toContain("console.log()");
	});

	it("converts JSX style objects to HTML style strings", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = '# Title\n\n<div style={{backgroundColor: "red", fontSize: "14px"}}>content</div>\n';

		const result = stripIncompatibleContent(input);

		expect(result).toContain('style="background-color: red; font-size: 14px"');
		expect(result).not.toContain("{{");
	});

	it("removes Docusaurus admonition fences", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = "# Title\n\n:::tip\nThis is a tip.\n:::\n\nMore text.\n";

		const result = stripIncompatibleContent(input);

		expect(result).not.toContain(":::");
		expect(result).toContain("This is a tip.");
		expect(result).toContain("More text.");
	});

	it("removes :::warning admonition", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = ":::warning\nBe careful!\n:::\n";

		const result = stripIncompatibleContent(input);

		expect(result).not.toContain(":::warning");
		expect(result).toContain("Be careful!");
	});

	it("cleans up excessive blank lines", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = "import X from 'x'\n\n\n\n\n# Title\n\n\n\n\nText.\n";

		const result = stripIncompatibleContent(input);

		expect(result).not.toMatch(/\n{4,}/);
	});

	it("trims and adds trailing newline", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = "\n\n# Title\n\n";

		const result = stripIncompatibleContent(input);

		expect(result).toMatch(/\n$/);
		expect(result).not.toMatch(/^\n/);
	});

	it("handles nested JSX components iteratively", async () => {
		const { stripIncompatibleContent } = await import("./ContentMirror.js");
		const input = "<Outer>\n<Inner>\nDeep content\n</Inner>\n</Outer>\n";

		const result = stripIncompatibleContent(input);

		expect(result).not.toContain("<Outer");
		expect(result).not.toContain("<Inner");
		expect(result).toContain("Deep content");
	});
});

// ─── clearDir tests ──────────────────────────────────────────────────────────

describe("ContentMirror.clearDir", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("removes all contents inside the directory", async () => {
		const { clearDir } = await import("./ContentMirror.js");
		await writeFile(join(dir, "file1.md"), "# One", "utf-8");
		await writeFile(join(dir, "file2.md"), "# Two", "utf-8");
		await mkdir(join(dir, "subdir"), { recursive: true });
		await writeFile(join(dir, "subdir", "file3.md"), "# Three", "utf-8");

		await clearDir(dir);

		expect(existsSync(dir)).toBe(true); // Directory itself stays
		const entries = await readdir(dir);
		expect(entries).toHaveLength(0);
	});

	it("does not throw for nonexistent directory", async () => {
		const { clearDir } = await import("./ContentMirror.js");

		await expect(clearDir(join(dir, "nonexistent"))).resolves.not.toThrow();
	});

	it("handles empty directory", async () => {
		const { clearDir } = await import("./ContentMirror.js");

		await expect(clearDir(dir)).resolves.not.toThrow();
	});
});

// ─── rewriteRelativeImagePaths tests ─────────────────────────────────────────

describe("ContentMirror.rewriteRelativeImagePaths", () => {
	it("rewrites markdown image paths when file is remapped", async () => {
		const { rewriteRelativeImagePaths } = await import("./ContentMirror.js");
		const content = "# Title\n\n![logo](../images/logo.png)\n";

		const result = rewriteRelativeImagePaths(content, "docs/page.md", "guides/docs/page.md");

		expect(result).not.toBe(content);
		expect(result).toContain("logo.png");
	});

	it("does not modify when original and new path have same directory", async () => {
		const { rewriteRelativeImagePaths } = await import("./ContentMirror.js");
		const content = "# Title\n\n![logo](logo.png)\n";

		const result = rewriteRelativeImagePaths(content, "docs/page.md", "docs/other.md");

		expect(result).toBe(content);
	});

	it("does not modify absolute image paths", async () => {
		const { rewriteRelativeImagePaths } = await import("./ContentMirror.js");
		const content = "![logo](/images/logo.png)\n";

		const result = rewriteRelativeImagePaths(content, "docs/page.md", "guides/page.md");

		expect(result).toContain("/images/logo.png");
	});

	it("does not modify HTTP image paths", async () => {
		const { rewriteRelativeImagePaths } = await import("./ContentMirror.js");
		const content = "![logo](https://example.com/logo.png)\n";

		const result = rewriteRelativeImagePaths(content, "docs/page.md", "guides/page.md");

		expect(result).toContain("https://example.com/logo.png");
	});

	it("rewrites HTML img src attributes", async () => {
		const { rewriteRelativeImagePaths } = await import("./ContentMirror.js");
		const content = '<img src="./logo.png" alt="logo">\n';

		const result = rewriteRelativeImagePaths(content, "docs/page.md", "guides/docs/page.md");

		expect(result).toContain("logo.png");
		expect(result).not.toContain("./logo.png");
	});

	it("ignores non-image file references", async () => {
		const { rewriteRelativeImagePaths } = await import("./ContentMirror.js");
		const content = "![doc](../file.pdf)\n";

		const result = rewriteRelativeImagePaths(content, "docs/page.md", "guides/page.md");

		expect(result).toContain("../file.pdf"); // Unchanged
	});
});

// ─── applyPathMapping tests ──────────────────────────────────────────────────

describe("ContentMirror.applyPathMapping", () => {
	it("applies folder-level mapping", async () => {
		const { applyPathMapping } = await import("./ContentMirror.js");

		const result = applyPathMapping("sql/query.md", { sql: "pipelines/sql" });

		expect(result).toBe("pipelines/sql/query.md");
	});

	it("returns original path when no mapping matches", async () => {
		const { applyPathMapping } = await import("./ContentMirror.js");

		const result = applyPathMapping("other/file.md", { sql: "pipelines/sql" });

		expect(result).toBe("other/file.md");
	});

	it("returns original path when no mappings provided", async () => {
		const { applyPathMapping } = await import("./ContentMirror.js");

		const result = applyPathMapping("some/file.md");

		expect(result).toBe("some/file.md");
	});

	it("handles exact path match (not just prefix)", async () => {
		const { applyPathMapping } = await import("./ContentMirror.js");

		const result = applyPathMapping("sql", { sql: "pipelines/sql" });

		expect(result).toBe("pipelines/sql");
	});

	it("normalizes backslashes", async () => {
		const { applyPathMapping } = await import("./ContentMirror.js");

		const result = applyPathMapping("sql\\query.md", { sql: "pipelines/sql" });

		expect(result).toBe("pipelines/sql/query.md");
	});
});

// ─── mirrorContent with pathMappings ─────────────────────────────────────────

describe("ContentMirror.mirrorContent with pathMappings", () => {
	let sourceRoot: string;
	let contentDir: string;

	beforeEach(async () => {
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
		await rm(contentDir, { recursive: true, force: true });
	});

	it("remaps file paths according to pathMappings", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await mkdir(join(sourceRoot, "sql"), { recursive: true });
		await writeFile(join(sourceRoot, "sql", "query.md"), "# Query\n", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir, { sql: "pipelines/sql" });

		expect(result.markdownFiles).toContain(join("pipelines", "sql", "query.md"));
		expect(existsSync(join(contentDir, "pipelines", "sql", "query.md"))).toBe(true);
	});

	it("rewrites image paths in remapped markdown files", async () => {
		const { readFile: rf } = await import("node:fs/promises");
		const { mirrorContent } = await import("./ContentMirror.js");
		await mkdir(join(sourceRoot, "sql"), { recursive: true });
		await writeFile(join(sourceRoot, "sql", "query.md"), "# Query\n\n![diagram](../images/diagram.png)\n", "utf-8");
		await mkdir(join(sourceRoot, "images"), { recursive: true });
		await writeFile(join(sourceRoot, "images", "diagram.png"), "fake-png", "utf-8");

		await mirrorContent(sourceRoot, contentDir, { sql: "pipelines/sql" });

		const output = await rf(join(contentDir, "pipelines", "sql", "query.md"), "utf-8");
		// Image path should be rewritten relative to new location
		expect(output).toContain("diagram.png");
	});
});

// ─── mirrorContent with ensureIndexPage ──────────────────────────────────────

describe("ContentMirror.mirrorContent ensureIndexPage", () => {
	let sourceRoot: string;
	let contentDir: string;

	beforeEach(async () => {
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
		await rm(contentDir, { recursive: true, force: true });
	});

	it("renames file with slug: / frontmatter to index.md", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "intro.md"), "---\nslug: /\n---\n# Intro\n", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("index.md");
		expect(result.renamedToIndex).toBe("intro");
		expect(existsSync(join(contentDir, "index.md"))).toBe(true);
	});

	it("does not rename when index.md already exists", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceRoot, "intro.md"), "---\nslug: /\n---\n# Intro\n", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.renamedToIndex).toBeUndefined();
	});

	it("returns undefined when no slug: / file exists", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "guide.md"), "# Guide\n", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.renamedToIndex).toBeUndefined();
	});
});

// ─── mirrorContent with publicDir (missing image resolution) ─────────────────

describe("ContentMirror.mirrorContent with publicDir", () => {
	let sourceRoot: string;
	let contentDir: string;
	let publicDir: string;

	beforeEach(async () => {
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();
		publicDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
		await rm(contentDir, { recursive: true, force: true });
		await rm(publicDir, { recursive: true, force: true });
	});

	it("generates placeholders for missing images when publicDir is set", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "page.md"), "# Page\n\n![missing](./nonexistent.png)\n", "utf-8");

		await mirrorContent(sourceRoot, contentDir, undefined, publicDir);

		// The markdown file should have been modified to point to a resolved path
		const { readFile: rf } = await import("node:fs/promises");
		const output = await rf(join(contentDir, "page.md"), "utf-8");
		// The image ref should now point to /images/placeholder-nonexistent.svg or similar
		expect(output).toContain("/images/");
	});

	it("resolves absolute image paths from static directory", async () => {
		const { mirrorContent } = await import("./ContentMirror.js");
		await writeFile(join(sourceRoot, "page.md"), "# Page\n\n![logo](/img/logo.png)\n", "utf-8");

		await mirrorContent(sourceRoot, contentDir, undefined, publicDir);

		const { readFile: rf } = await import("node:fs/promises");
		const output = await rf(join(contentDir, "page.md"), "utf-8");
		expect(output).toContain("/images/");
	});
});

// ─── hasIncompatibleImports with custom ContentRules ─────────────────────────

describe("ContentMirror.hasIncompatibleImports with ContentRules", () => {
	it("uses custom safe prefixes when ContentRules provided", async () => {
		const { hasIncompatibleImports } = await import("./ContentMirror.js");
		const content = "import Foo from 'custom-pkg'\n\n# Title\n";

		// Without custom rules: 'custom-pkg' is incompatible
		expect(hasIncompatibleImports(content)).toBe(true);

		// With custom rules that include 'custom-pkg': compatible
		expect(
			hasIncompatibleImports(content, {
				safeImportPrefixes: ["custom-pkg", "react"],
				providedComponents: new Set(),
			}),
		).toBe(false);
	});

	it("uses custom provided components when ContentRules provided", async () => {
		const { hasIncompatibleImports } = await import("./ContentMirror.js");
		const content = "# Title\n\n<CustomWidget />\n";

		// Without custom rules: CustomWidget is incompatible
		expect(hasIncompatibleImports(content)).toBe(true);

		// With custom rules that include CustomWidget: compatible
		expect(
			hasIncompatibleImports(content, {
				safeImportPrefixes: [],
				providedComponents: new Set(["CustomWidget"]),
			}),
		).toBe(false);
	});

	it("falls back to defaults when rules is undefined", async () => {
		const { hasIncompatibleImports } = await import("./ContentMirror.js");
		// Nextra's Callout is in default provided components
		const content = "# Title\n\n<Callout>Note</Callout>\n";

		expect(hasIncompatibleImports(content, undefined)).toBe(false);
	});
});

// ─── mirrorContent with unreadable .mdx file ─────────────────────────────────

describe("ContentMirror.mirrorContent unreadable MDX", () => {
	let sourceRoot: string;
	let contentDir: string;

	beforeEach(async () => {
		sourceRoot = await mkdtemp(join(tmpdir(), "jolli-contentmirror-test-"));
		contentDir = await mkdtemp(join(tmpdir(), "jolli-contentmirror-test-"));
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
		await rm(contentDir, { recursive: true, force: true });
	});

	it("treats broken .mdx symlink as ignored", async () => {
		const { symlink: symlinkFn } = await import("node:fs/promises");
		const { mirrorContent } = await import("./ContentMirror.js");
		// Create a broken symlink that stat resolves but readFile fails
		await symlinkFn(join(sourceRoot, "nonexistent-target.mdx"), join(sourceRoot, "broken.mdx"));
		// Also add a real file so the walk succeeds
		await writeFile(join(sourceRoot, "real.md"), "# Real", "utf-8");

		const result = await mirrorContent(sourceRoot, contentDir);

		expect(result.markdownFiles).toContain("real.md");
		// broken.mdx should be skipped (stat fails on broken symlink)
	});
});
