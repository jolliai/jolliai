/**
 * Tests for AssetResolver — resolves external images and favicon for the build.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-assetresolver-test-"));
}

describe("AssetResolver", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ── generatePlaceholderSvg ───────────────────────────────────────────────

	describe("generatePlaceholderSvg", () => {
		it("generates valid SVG content", async () => {
			const { generatePlaceholderSvg } = await import("./AssetResolver.js");

			const svg = generatePlaceholderSvg("logo.png");

			expect(svg).toContain("<svg");
			expect(svg).toContain("</svg>");
			expect(svg).toContain("logo.png");
		});

		it("includes the filename in the SVG", async () => {
			const { generatePlaceholderSvg } = await import("./AssetResolver.js");

			const svg = generatePlaceholderSvg("my-image.jpg");

			expect(svg).toContain("my-image.jpg");
		});

		it("shows 'Missing image' text", async () => {
			const { generatePlaceholderSvg } = await import("./AssetResolver.js");

			const svg = generatePlaceholderSvg("test.png");

			expect(svg).toContain("Missing image");
		});

		it("escapes XML special characters in filename", async () => {
			const { generatePlaceholderSvg } = await import("./AssetResolver.js");

			const svg = generatePlaceholderSvg("file<with>&special");

			expect(svg).toContain("&lt;");
			expect(svg).toContain("&gt;");
			expect(svg).toContain("&amp;");
			expect(svg).not.toContain("<with>");
		});

		it("generates SVG with correct dimensions", async () => {
			const { generatePlaceholderSvg } = await import("./AssetResolver.js");

			const svg = generatePlaceholderSvg("test.png");

			expect(svg).toContain('width="400"');
			expect(svg).toContain('height="300"');
		});
	});

	// ── resolveExternalImage ────────────────────────────────────────────────

	describe("resolveExternalImage", () => {
		it("finds image in project static directory", async () => {
			const { resolveExternalImage } = await import("./AssetResolver.js");
			// Create project structure: project/static/img/logo.svg
			const projectDir = join(tempDir, "project");
			const docsDir = join(projectDir, "docs");
			const staticDir = join(projectDir, "static", "img");
			await mkdir(docsDir, { recursive: true });
			await mkdir(staticDir, { recursive: true });
			// Add marker so findProjectRoot finds this
			await writeFile(join(projectDir, "package.json"), "{}", "utf-8");
			await writeFile(join(staticDir, "logo.svg"), "<svg/>", "utf-8");

			const result = resolveExternalImage("../static/img/logo.svg", docsDir, docsDir);

			expect(result.isPlaceholder).toBe(false);
			expect(result.sourcePath).toBeDefined();
			expect(result.publicPath).toContain("images/");
		});

		it("returns placeholder when image not found", async () => {
			const { resolveExternalImage } = await import("./AssetResolver.js");
			const docsDir = join(tempDir, "docs");
			await mkdir(docsDir, { recursive: true });

			const result = resolveExternalImage("nonexistent.png", docsDir, docsDir);

			expect(result.isPlaceholder).toBe(true);
			expect(result.sourcePath).toBeUndefined();
			expect(result.publicPath).toContain("placeholder-");
		});

		it("generates unique public path for found images", async () => {
			const { resolveExternalImage } = await import("./AssetResolver.js");
			const projectDir = join(tempDir, "project");
			const docsDir = join(projectDir, "docs");
			await mkdir(docsDir, { recursive: true });
			await writeFile(join(projectDir, "package.json"), "{}", "utf-8");
			const imgDir = join(projectDir, "static", "img");
			await mkdir(imgDir, { recursive: true });
			await writeFile(join(imgDir, "logo.svg"), "<svg/>", "utf-8");

			const result = resolveExternalImage("../static/img/logo.svg", docsDir, docsDir);

			expect(result.publicPath).toMatch(/^images\//);
			expect(result.publicPath).toContain("logo.svg");
		});
	});

	// ── copyExternalAsset ───────────────────────────────────────────────────

	describe("copyExternalAsset", () => {
		it("copies a real file to the public directory", async () => {
			const { copyExternalAsset } = await import("./AssetResolver.js");
			const sourceFile = join(tempDir, "source.svg");
			await writeFile(sourceFile, "<svg>test</svg>", "utf-8");
			const publicDir = join(tempDir, "public");
			await mkdir(publicDir, { recursive: true });

			await copyExternalAsset(
				{ sourcePath: sourceFile, publicPath: "images/source.svg", isPlaceholder: false },
				publicDir,
			);

			const destPath = join(publicDir, "images", "source.svg");
			expect(existsSync(destPath)).toBe(true);
			const content = await readFile(destPath, "utf-8");
			expect(content).toBe("<svg>test</svg>");
		});

		it("generates placeholder SVG when source is missing", async () => {
			const { copyExternalAsset } = await import("./AssetResolver.js");
			const publicDir = join(tempDir, "public");
			await mkdir(publicDir, { recursive: true });

			await copyExternalAsset({ publicPath: "images/placeholder-logo.svg", isPlaceholder: true }, publicDir);

			const destPath = join(publicDir, "images", "placeholder-logo.svg");
			expect(existsSync(destPath)).toBe(true);
			const content = await readFile(destPath, "utf-8");
			expect(content).toContain("<svg");
			expect(content).toContain("Missing image");
		});

		it("creates intermediate directories", async () => {
			const { copyExternalAsset } = await import("./AssetResolver.js");
			const sourceFile = join(tempDir, "img.png");
			await writeFile(sourceFile, "fake-png", "utf-8");
			const publicDir = join(tempDir, "public");
			// Don't create publicDir or images/ — should be created automatically

			await copyExternalAsset(
				{ sourcePath: sourceFile, publicPath: "images/deep/nested/img.png", isPlaceholder: false },
				publicDir,
			);

			expect(existsSync(join(publicDir, "images", "deep", "nested", "img.png"))).toBe(true);
		});
	});

	// ── resolveFavicon ──────────────────────────────────────────────────────

	describe("resolveFavicon", () => {
		it("copies existing favicon to public/favicon.ico", async () => {
			const { resolveFavicon } = await import("./AssetResolver.js");
			const sourceRoot = join(tempDir, "docs");
			await mkdir(sourceRoot, { recursive: true });
			await writeFile(join(sourceRoot, "my-favicon.ico"), "favicon-data", "utf-8");
			const publicDir = join(tempDir, "public");
			await mkdir(publicDir, { recursive: true });

			await resolveFavicon("my-favicon.ico", sourceRoot, publicDir);

			expect(existsSync(join(publicDir, "favicon.ico"))).toBe(true);
			const content = await readFile(join(publicDir, "favicon.ico"), "utf-8");
			expect(content).toBe("favicon-data");
		});

		it("generates default favicon when path is undefined", async () => {
			const { resolveFavicon } = await import("./AssetResolver.js");
			const publicDir = join(tempDir, "public");

			await resolveFavicon(undefined, tempDir, publicDir);

			expect(existsSync(join(publicDir, "favicon.ico"))).toBe(true);
			const content = await readFile(join(publicDir, "favicon.ico"), "utf-8");
			expect(content).toContain("<svg");
			expect(content).toContain("J"); // Jolli "J" favicon
		});

		it("generates default favicon when path points to nonexistent file", async () => {
			const { resolveFavicon } = await import("./AssetResolver.js");
			const publicDir = join(tempDir, "public");

			await resolveFavicon("nonexistent.ico", tempDir, publicDir);

			expect(existsSync(join(publicDir, "favicon.ico"))).toBe(true);
			const content = await readFile(join(publicDir, "favicon.ico"), "utf-8");
			expect(content).toContain("<svg"); // Falls back to default
		});
	});

	// ── resolveExternalImage — additional branch coverage ────────────────────

	describe("resolveExternalImage branches", () => {
		it("tries direct resolve from originalMdDir", async () => {
			const { resolveExternalImage } = await import("./AssetResolver.js");
			const projectDir = join(tempDir, "project");
			const docsDir = join(projectDir, "docs");
			const imgDir = join(docsDir, "images");
			await mkdir(imgDir, { recursive: true });
			await writeFile(join(projectDir, "package.json"), "{}", "utf-8");
			await writeFile(join(imgDir, "diagram.png"), "fake", "utf-8");

			const result = resolveExternalImage("images/diagram.png", docsDir, docsDir);

			expect(result.isPlaceholder).toBe(false);
		});

		it("falls back to parent of sourceRoot", async () => {
			const { resolveExternalImage } = await import("./AssetResolver.js");
			const docsDir = join(tempDir, "docs");
			await mkdir(docsDir, { recursive: true });
			const imgFile = join(tempDir, "static", "logo.png");
			await mkdir(join(tempDir, "static"), { recursive: true });
			await writeFile(imgFile, "fake", "utf-8");

			const result = resolveExternalImage("static/logo.png", docsDir, docsDir);

			expect(result.isPlaceholder).toBe(false);
		});

		it("generates placeholder with correct naming for extensionless file", async () => {
			const { resolveExternalImage } = await import("./AssetResolver.js");

			const result = resolveExternalImage("missing-file", tempDir, tempDir);

			expect(result.isPlaceholder).toBe(true);
			expect(result.publicPath).toContain("placeholder-");
		});
	});

	// ── copyExternalAsset — placeholder content ─────────────────────────────

	describe("copyExternalAsset placeholder content", () => {
		it("strips placeholder- prefix and .svg extension from filename in SVG", async () => {
			const { copyExternalAsset } = await import("./AssetResolver.js");
			const publicDir = join(tempDir, "public");

			await copyExternalAsset({ publicPath: "images/placeholder-my-image.svg", isPlaceholder: true }, publicDir);

			const content = await readFile(join(publicDir, "images", "placeholder-my-image.svg"), "utf-8");
			expect(content).toContain("my-image");
		});
	});
});
